/**
 * Fallback / failover logic.
 *
 * When a chat completion request fails (rate limit, 5xx, overloaded, …)
 * the router consults the user-configured fallback rules and retries
 * the request against the next model in the chain.
 *
 * A rule looks like:
 *   { sourceModel: "groq/llama-3.3-70b", targetModel: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
 *     triggerStatus: [429, 503], enabled: true }
 *
 * The router also auto-fallbacks when no provider is configured for the
 * requested model (so a user can type `gpt-4o` and we'll try openrouter,
 * together, groq, … in order until one succeeds).
 */

import type { ChatCompletionRequest } from "../types";
import * as store from "./config-store";

interface ErrorWithStatus {
  status?: number;
  message?: string;
}

const FALLBACK_STATUS_PATTERNS = new Set([429, 403, 500, 502, 503, 504, 402]);

const FALLBACK_MESSAGE_PATTERNS = [
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /quota/i,
  /exhausted/i,
  /capacity/i,
  /high\s+traffic/i,
  /overloaded/i,
  /no active provider connection/i,
  /not found|unknown model|invalid model|no provider found/i,
  /insufficient\s*quota|insufficient_tokens|billing_error/i,
  /tool.?calling.*not\s+supported|not\s+support.*tool/i,
];

export function extractStatus(err: unknown): number | undefined {
  if (!err) return undefined;
  if (typeof err === "object" && err !== null) {
    const e = err as ErrorWithStatus;
    if (typeof e.status === "number") return e.status;
  }
  if (err instanceof Error) {
    const match = err.message.match(/\b(429|403|500|502|503|504|400|401|402|422)\b/);
    if (match) return parseInt(match[1]!, 10);
  }
  return undefined;
}

export function shouldTriggerFallback(
  rule: store.FallbackRule,
  err: unknown
): boolean {
  if (!rule.enabled) return false;
  const status = extractStatus(err);
  if (status && rule.triggerStatus.includes(status)) return true;
  if (rule.triggerStatus.length === 0) return true;
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (FALLBACK_MESSAGE_PATTERNS.some((p) => p.test(msg))) return true;
  return false;
}

/** Return ordered list of model candidates for a given starting model. */
export function resolveCandidates(startModel: string): { model: string; rule?: store.FallbackRule }[] {
  const candidates: { model: string; rule?: store.FallbackRule }[] = [
    { model: startModel },
  ];
  const visited = new Set<string>([startModel]);

  for (const rule of store.listFallbacks()) {
    if (rule.sourceModel === startModel && !visited.has(rule.targetModel)) {
      visited.add(rule.targetModel);
      candidates.push({ model: rule.targetModel, rule });
    }
  }
  return candidates;
}
