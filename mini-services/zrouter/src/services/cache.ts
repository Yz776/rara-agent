/**
 * LRU cache for identical chat completion requests.
 *
 * Caches the *non-streaming* response of a request keyed by
 * hash(model + messages + temperature + top_p + max_tokens). Streaming
 * responses are never cached (they'd defeat the purpose).
 *
 * Configurable: enable/disable, max entries (LRU eviction), per-entry TTL.
 * Settings persisted in SQLite so cache config survives restarts.
 *
 * Cache hits return instantly without consuming upstream tokens — major cost
 * savings for agentic loops that re-ask the same question.
 */

import { getSetting, setSetting } from "./db";
import crypto from "node:crypto";

export interface CacheSettings {
  enabled: boolean;
  maxEntries: number;
  ttlSeconds: number;
  /** Only cache responses under this many tokens (avoid caching huge outputs). */
  maxResponseTokens: number;
}

const DEFAULT_SETTINGS: CacheSettings = {
  enabled: false,
  maxEntries: 1000,
  ttlSeconds: 3600, // 1 hour
  maxResponseTokens: 4096,
};

interface CacheEntry {
  response: unknown;
  cachedAt: number;
  expiresAt: number;
  hits: number;
}

const cache = new Map<string, CacheEntry>();
let settingsCache: CacheSettings | null = null;

export function getCacheSettings(): CacheSettings {
  if (settingsCache) return settingsCache;
  try {
    const raw = getSetting("cache_settings", JSON.stringify(DEFAULT_SETTINGS));
    const parsed = JSON.parse(raw) as Partial<CacheSettings>;
    settingsCache = {
      enabled: parsed.enabled ?? DEFAULT_SETTINGS.enabled,
      maxEntries: parsed.maxEntries ?? DEFAULT_SETTINGS.maxEntries,
      ttlSeconds: parsed.ttlSeconds ?? DEFAULT_SETTINGS.ttlSeconds,
      maxResponseTokens: parsed.maxResponseTokens ?? DEFAULT_SETTINGS.maxResponseTokens,
    };
    return settingsCache;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setCacheSettings(s: Partial<CacheSettings>): CacheSettings {
  const current = getCacheSettings();
  settingsCache = {
    enabled: s.enabled ?? current.enabled,
    maxEntries: s.maxEntries ?? current.maxEntries,
    ttlSeconds: s.ttlSeconds ?? current.ttlSeconds,
    maxResponseTokens: s.maxResponseTokens ?? current.maxResponseTokens,
  };
  setSetting("cache_settings", JSON.stringify(settingsCache));
  if (!settingsCache.enabled) clearCache();
  return settingsCache;
}

/** Build a stable cache key from a request body. */
function buildKey(req: {
  model: string;
  messages: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}): string {
  // Only hash the fields that affect the response. Drop stream, user, etc.
  const relevant = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 1,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
  };
  return crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

/** Look up a cached response. Returns undefined on miss or expired. */
export function getCachedResponse(req: {
  model: string;
  messages: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}): { response: unknown; entry: CacheEntry } | undefined {
  const settings = getCacheSettings();
  if (!settings.enabled) return undefined;
  const key = buildKey(req);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  entry.hits++;
  // Move to end (most recently used) — Map preserves insertion order
  cache.delete(key);
  cache.set(key, entry);
  return { response: entry.response, entry };
}

/** Store a response in the cache (if enabled and within size limits). */
export function setCachedResponse(
  req: {
    model: string;
    messages: unknown;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
  },
  response: { usage?: { completion_tokens?: number } }
): void {
  const settings = getCacheSettings();
  if (!settings.enabled) return;
  // Don't cache if response is too large
  const completionTokens = response.usage?.completion_tokens ?? 0;
  if (completionTokens > settings.maxResponseTokens) return;
  const key = buildKey(req);
  const now = Date.now();
  cache.set(key, {
    response,
    cachedAt: now,
    expiresAt: now + settings.ttlSeconds * 1000,
    hits: 0,
  });
  // LRU eviction
  while (cache.size > settings.maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** Clear all cached entries. */
export function clearCache(): void {
  cache.clear();
}

/** Stats for the dashboard. */
export function getCacheStats(): {
  entries: number;
  totalHits: number;
  hitRate: number;
  enabled: boolean;
  maxEntries: number;
  ttlSeconds: number;
} {
  let totalHits = 0;
  for (const entry of cache.values()) totalHits += entry.hits;
  // Hit rate = total hits / (hits + 1) — rough approximation since we don't
  // track misses. We track a global counter below for accuracy.
  return {
    entries: cache.size,
    totalHits,
    hitRate: _hitRate(),
    enabled: getCacheSettings().enabled,
    maxEntries: getCacheSettings().maxEntries,
    ttlSeconds: getCacheSettings().ttlSeconds,
  };
}

// Global hit/miss counters (reset on restart)
let _hits = 0;
let _misses = 0;

export function recordCacheHit(): void { _hits++; }
export function recordCacheMiss(): void { _misses++; }
function _hitRate(): number {
  const total = _hits + _misses;
  return total === 0 ? 0 : _hits / total;
}
