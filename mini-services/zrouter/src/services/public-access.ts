/**
 * Public access — lets anonymous callers (no API key) use the gateway
 * without any auth at all.
 *
 * Modes:
 *  - models: 'all'   → any model the admin has enabled (via Providers or
 *                     the Pool) can be called anonymously; admin pays the
 *                     upstream cost. Per-IP rate limit applies.
 *  - models: 'free'  → only free-tier models (the original behaviour):
 *                     ids ending in -free plus the explicit exceptions.
 *
 * The toggle, per-IP limit, and mode are stored in the `settings` table
 * under the key `public_free_access`. The state survives restarts; the
 * per-IP counters are in-memory and reset on restart.
 */

import { getSetting, setSetting } from "./db";

export type PublicAccessModelMode = "all" | "free";

export interface PublicAccessSettings {
  enabled: boolean;
  requestsPerHour: number;
  models: PublicAccessModelMode;
}

const SETTINGS_KEY = "public_free_access";
const DEFAULTS: PublicAccessSettings = {
  enabled: false,
  requestsPerHour: 30,
  models: "free",
};

/** Models any anonymous caller may use when mode='free'. big-pickle is free
 * on OpenCode even without a "-free" suffix, so it is listed explicitly. */
const FREE_MODEL_EXCEPTIONS = new Set(["opencode/big-pickle", "opencode/space-bunny-free"]);

export function isFreeModel(model: string): boolean {
  const id = model.toLowerCase();
  return id.endsWith("-free") || FREE_MODEL_EXCEPTIONS.has(id);
}

export function getPublicAccessSettings(): PublicAccessSettings {
  try {
    const parsed = JSON.parse(getSetting(SETTINGS_KEY, JSON.stringify(DEFAULTS))) as Partial<PublicAccessSettings>;
    const mode: PublicAccessModelMode = parsed.models === "all" ? "all" : "free";
    return {
      enabled: parsed.enabled ?? false,
      requestsPerHour: Math.max(1, Math.min(1000, parsed.requestsPerHour ?? DEFAULTS.requestsPerHour)),
      models: mode,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setPublicAccessSettings(s: Partial<PublicAccessSettings>): PublicAccessSettings {
  const current = getPublicAccessSettings();
  const next: PublicAccessSettings = {
    enabled: s.enabled ?? current.enabled,
    requestsPerHour: Math.max(1, Math.min(1000, s.requestsPerHour ?? current.requestsPerHour)),
    models: s.models === "all" ? "all" : s.models === "free" ? "free" : current.models,
  };
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Returns true when the caller with `model` is allowed under the current
 * public-access policy. Always false when public access is disabled. When
 * mode='all', any model is allowed. When mode='free', only isFreeModel(m).
 */
export function isAnonymousModelAllowed(model: string): boolean {
  const s = getPublicAccessSettings();
  if (!s.enabled) return false;
  if (s.models === "all") return true;
  return isFreeModel(model);
}

// ── Per-IP limiter (in-memory; resets on restart) ───────────────────────────
const hits = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 60 * 1000;

function sweep(now: number): void {
  if (hits.size < 10_000) return;
  for (const [ip, rec] of hits) {
    if (rec.resetAt <= now) hits.delete(ip);
  }
}

/** Returns true when the IP still has budget this hour. */
export function consumeAnonymousQuota(ip: string): boolean {
  const { enabled, requestsPerHour } = getPublicAccessSettings();
  if (!enabled) return false;
  const now = Date.now();
  sweep(now);
  const rec = hits.get(ip);
  if (!rec || rec.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= requestsPerHour) return false;
  rec.count += 1;
  return true;
}
