/**
 * Provider registry — routes a `provider/model` request to the right
 * executor. Credentials come from the unified key pool (services/key-pool)
 * when one or more entries exist for the requested provider; otherwise we
 * fall back to the legacy single credential in config-store (so existing
 * deployments that have not migrated to the pool keep working).
 *
 * On a 429/403/503/quota error from the upstream, the caller (chat.ts)
 * catches the error, asks the pool to mark the offending entry as cooled
 * down, and tries again — round-robin picks the next healthy entry. This
 * continues for up to `MAX_POOL_ATTEMPTS` entries before surfacing the
 * error and triggering the model-level fallback chain.
 */

import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../types";
import {
  PROVIDER_CATALOG,
  buildExecutor,
  findProviderDef,
  listCustomProviderDefs,
  type ProviderDefinition,
} from "../providers/catalog";
import * as store from "./config-store";
import {
  pickKey,
  markCooldown,
  markSuccess,
  entriesForProvider,
  type PickedKey,
} from "./key-pool";

const MAX_POOL_ATTEMPTS = 6;

/** Extract the provider prefix from a `provider/model` id. */
export function splitModelId(model: string): { providerId: string; model: string } {
  const slash = model.indexOf("/");
  if (slash < 0) {
    // Bare model name — default to "openai" so requests like `gpt-4o` still work.
    return { providerId: "openai", model };
  }
  const providerId = model.slice(0, slash);
  const modelName = model.slice(slash + 1);
  return { providerId, model: modelName };
}

/**
 * Build an executor for the given provider using credentials from a pool
 * entry (preferred) or the legacy config-store credential (fallback).
 *
 * Returns the executor instance AND a stable cache key so the same
 * (provider, poolEntryId) tuple returns the same executor on subsequent
 * calls — executor instances are stateless wrappers but we avoid
 * rebuilding identical instances.
 */
const executorCache = new Map<string, AIProvider>();

function buildForPoolEntry(
  def: ProviderDefinition,
  picked: PickedKey
): AIProvider {
  const cacheKey = `pool:${def.id}:${picked.poolEntryId}`;
  const cached = executorCache.get(cacheKey);
  if (cached) return cached;
  const instance = buildExecutor(def, picked.apiKey, picked.baseUrl) as AIProvider;
  // If the pool entry has a per-key proxyUrl, stash it on the executor so
  // retry.ts / executor fetches use it. We do this by attaching a private
  // symbol-keyed property — executors that don't read it simply ignore it.
  attachProxyOverride(instance, picked.proxyUrl);
  executorCache.set(cacheKey, instance);
  return instance;
}

function buildForLegacy(def: ProviderDefinition): AIProvider | null {
  // Legacy single-credential path (config.json providers[]). Used when no
  // pool entries exist for the provider yet — preserves backward compat.
  const cred = store.findProvider(def.id);
  if (!cred || !cred.enabled) return null;
  if (def.requiresApiKey && !cred.apiKey) return null;
  const cacheKey = `legacy:${def.id}`;
  const cached = executorCache.get(cacheKey);
  if (cached) return cached;
  const instance = buildExecutor(def, cred.apiKey, cred.baseUrl) as AIProvider;
  executorCache.set(cacheKey, instance);
  return instance;
}

const PROXY_OVERRIDE = Symbol("krouter.pool.proxyUrl");

function attachProxyOverride(exec: AIProvider, proxyUrl?: string): void {
  if (!proxyUrl) return;
  // Stash as a plain property — retry.ts can detect it via (exec as any)[PROXY_OVERRIDE]
  (exec as unknown as Record<symbol, string>)[PROXY_OVERRIDE] = proxyUrl;
}

export function getProxyOverride(exec: AIProvider): string | undefined {
  return (exec as unknown as Record<symbol, string | undefined>)[PROXY_OVERRIDE];
}

/**
 * Try a chat completion against one specific pool entry (or the legacy
 * credential). On a quota/rate-limit error from the upstream, mark the
 * entry as cooled down and let the caller (chat.ts) try the next entry.
 */
export async function chatCompletionWithPool(
  req: ChatCompletionRequest
): Promise<{ response: ChatCompletionResponse; poolEntryId?: string }> {
  const { providerId } = splitModelId(req.model);
  const def = findProviderDef(providerId);
  if (!def) {
    throw new Error(
      `No provider definition for "${providerId}". Configure credentials in /admin.`
    );
  }

  // Pool path
  const hasPool = entriesForProvider(providerId) > 0;
  if (hasPool) {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_POOL_ATTEMPTS; attempt++) {
      const picked = pickKey(providerId);
      if (!picked) {
        // Pool exhausted (all entries cooling down) — surface last error.
        throw lastErr ?? new Error(
          `All pool entries for "${providerId}" are in cooldown. Try again in a moment.`
        );
      }
      const exec = buildForPoolEntry(def, picked);
      try {
        const response = await exec.chatCompletion(req);
        markSuccess(picked.poolEntryId);
        return { response, poolEntryId: picked.poolEntryId };
      } catch (err) {
        lastErr = err;
        if (isQuotaOrRateLimit(err)) {
          // Cool down this entry and rotate to the next one.
          markCooldown(
            picked.poolEntryId,
            DEFAULT_COOLDOWN_MS,
            err instanceof Error ? err.message : String(err)
          );
          continue;
        }
        // Non-quota error — surface immediately; do not cool down.
        throw err;
      }
    }
    throw lastErr ?? new Error(`Pool exhausted for "${providerId}"`);
  }

  // Legacy single-credential path
  const exec = buildForLegacy(def);
  if (!exec) {
    throw new Error(
      `No active provider connection for "${providerId}". Configure credentials in /admin or add pool entries.`
    );
  }
  const response = await exec.chatCompletion(req);
  return { response };
}

export async function* chatCompletionStreamWithPool(
  req: ChatCompletionRequest
): AsyncGenerator<ChatCompletionChunk, void, void> {
  const { providerId } = splitModelId(req.model);
  const def = findProviderDef(providerId);
  if (!def) {
    throw new Error(
      `No provider definition for "${providerId}". Configure credentials in /admin.`
    );
  }

  const hasPool = entriesForProvider(providerId) > 0;
  if (hasPool) {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_POOL_ATTEMPTS; attempt++) {
      const picked = pickKey(providerId);
      if (!picked) {
        throw lastErr ?? new Error(
          `All pool entries for "${providerId}" are in cooldown. Try again in a moment.`
        );
      }
      const exec = buildForPoolEntry(def, picked);
      // For streams we cannot silently retry mid-stream — once the first
      // chunk has been emitted, switching providers would corrupt the
      // output. So we only retry on the *initial* connection error; after
      // the first successful chunk, errors propagate.
      let firstChunkYielded = false;
      try {
        // Pre-flight: kick off the stream; if the upstream returns an
        // error before the first chunk, we can rotate. We wrap the
        // generator and surface errors via a throw.
        const gen = exec.chatCompletionStream(req);
        // Try to pull the first chunk eagerly so connection-level errors
        // (401/429/503) surface here rather than mid-stream.
        const first = await gen.next();
        if (first.done) {
          // Empty stream — treat as success with no output.
          markSuccess(picked.poolEntryId);
          return;
        }
        firstChunkYielded = true;
        yield first.value as ChatCompletionChunk;
        // Stream the rest
        for await (const chunk of gen) {
          yield chunk as ChatCompletionChunk;
        }
        markSuccess(picked.poolEntryId);
        return;
      } catch (err) {
        lastErr = err;
        if (!firstChunkYielded && isQuotaOrRateLimit(err)) {
          markCooldown(
            picked.poolEntryId,
            DEFAULT_COOLDOWN_MS,
            err instanceof Error ? err.message : String(err)
          );
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error(`Pool exhausted for "${providerId}"`);
  }

  // Legacy path
  const exec = buildForLegacy(def);
  if (!exec) {
    throw new Error(
      `No active provider connection for "${providerId}". Configure credentials in /admin or add pool entries.`
    );
  }
  yield* exec.chatCompletionStream(req);
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Heuristic: does this error look like an upstream rate-limit / quota
 * exhaustion? If yes, the pool should cool down the entry and try the next.
 */
function isQuotaOrRateLimit(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Status code embedded in the message?
  const statusMatch = msg.match(/\b(401|403|429|503)\b/);
  if (statusMatch) return true;
  return /rate.?limit|quota|insufficient.*credit|exceeded|overloaded|too many requests|exhausted/i.test(msg);
}

/** Force a provider to rebuild on next access (e.g. after credential update). */
export function invalidate(providerId?: string): void {
  if (providerId) {
    for (const k of [...executorCache.keys()]) {
      if (k.includes(`:${providerId}:`) || k === `legacy:${providerId}`) {
        executorCache.delete(k);
      }
    }
  } else {
    executorCache.clear();
  }
}

/** Return all configured (enabled) executors — used by /v1/models. */
export function activeExecutors(): AIProvider[] {
  const result: AIProvider[] = [];
  const seen = new Set<string>();
  // Pool path: one executor per (provider, poolEntryId).
  for (const def of [...PROVIDER_CATALOG, ...listCustomProviderDefs()]) {
    const hasPool = entriesForProvider(def.id) > 0;
    if (hasPool) {
      // Just use the first pool entry to list models — different keys for the
      // same provider all hit the same upstream /models endpoint.
      const picked = pickKey(def.id);
      if (picked) {
        try {
          const exec = buildForPoolEntry(def, picked);
          result.push(exec);
          seen.add(def.id);
        } catch {
          /* skip */
        }
      }
    } else {
      const exec = buildForLegacy(def);
      if (exec && !seen.has(def.id)) {
        result.push(exec);
        seen.add(def.id);
      }
    }
  }
  return result;
}

/** Return provider definition for a given provider id (or alias). */
export function getProviderDef(providerId: string): ProviderDefinition | undefined {
  return findProviderDef(providerId);
}

/** Aggregate /v1/models across all enabled providers. */
export async function listAllModels(): Promise<ModelObject[]> {
  const executors = activeExecutors();
  const results = await Promise.allSettled(
    executors.map(async (e) => {
      try {
        return await e.listModels();
      } catch {
        return [];
      }
    })
  );
  const models: ModelObject[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const m of r.value) {
        models.push(m);
      }
    }
  }
  return models;
}

export interface ChatOptions {
  apiKeyId?: string;
}

/** Non-streaming chat completion — routes via the pool when available. */
export async function chatCompletion(
  req: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const { response } = await chatCompletionWithPool(req);
  return response;
}

/** Streaming chat completion — yields standard OpenAI chunks. */
export async function* chatCompletionStream(
  req: ChatCompletionRequest
): AsyncGenerator<ChatCompletionChunk, void, void> {
  yield* chatCompletionStreamWithPool(req);
}

/** Internal: get an executor instance for direct use (embeddings etc.). */
export function getExecutorInstance(providerId: string): AIProvider | null {
  const def = findProviderDef(providerId);
  if (!def) return null;
  // Try pool first; fall back to legacy.
  if (entriesForProvider(providerId) > 0) {
    const picked = pickKey(providerId);
    if (picked) return buildForPoolEntry(def, picked);
  }
  return buildForLegacy(def);
}
