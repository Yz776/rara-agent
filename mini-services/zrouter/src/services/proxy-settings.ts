/**
 * Proxy routing settings — disk-backed (via the SQLite settings table) so the
 * "auto proxy routed" feature survives restarts.
 *
 * When `enabled` is true, every outbound fetch the gateway makes through
 * `fetchWithRetry` will be wrapped with a proxy from the proxy pool, picked
 * according to `strategy`. If a fetch returns 403/429/503 the proxy is
 * blacklisted and a different one is retried with.
 */

import { getSetting, setSetting } from "./db";
import {
  selectNextProxy,
  selectRandomActiveProxy,
  rotateProxyAfterFailure,
  handleBlockedIp,
  listProxies,
  findProxy,
  type Proxy,
} from "./proxy-manager";

export type ProxyStrategy = "weighted" | "random" | "round-robin";

/**
 * off      — never use the pool
 * fallback — direct first; rotate through the pool only on 429/403/503 (quota / IP-block)
 * always   — every outbound request goes through the pool
 */
export type ProxyMode = "off" | "fallback" | "always";

export interface ProxySettings {
  enabled: boolean;
  strategy: ProxyStrategy;
  mode: ProxyMode;
}

const DEFAULT_SETTINGS: ProxySettings = {
  enabled: false,
  strategy: "weighted",
  mode: "off",
};

/** Normalize legacy {enabled} and/or {mode} into a consistent tri-state. */
function normalizeMode(enabled: boolean | undefined, mode: ProxyMode | undefined): ProxyMode {
  if (mode === "off" || mode === "fallback" || mode === "always") return mode;
  return enabled ? "always" : "off";
}

// Round-robin state (in-memory, resets on restart)
let rrIndex = 0;

export function getProxySettings(): ProxySettings {
  try {
    const raw = getSetting("proxy_routing", JSON.stringify(DEFAULT_SETTINGS));
    const parsed = JSON.parse(raw) as Partial<ProxySettings>;
    const mode = normalizeMode(parsed.enabled, parsed.mode);
    return {
      enabled: mode !== "off",
      strategy: (parsed.strategy as ProxyStrategy) ?? "weighted",
      mode,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setProxySettings(s: Partial<ProxySettings>): ProxySettings {
  const current = getProxySettings();
  const next: ProxySettings = {
    enabled: normalizeMode(s.enabled, s.mode) !== "off",
    strategy: s.strategy ?? current.strategy,
    mode: normalizeMode(s.enabled ?? (s.mode ? undefined : current.enabled), s.mode),
  };
  setSetting("proxy_routing", JSON.stringify(next));
  return next;
}

export function getProxyMode(): ProxyMode {
  return getProxySettings().mode;
}

/** Pick the next proxy based on the configured strategy. */
export function pickProxy(): Proxy | undefined {
  const settings = getProxySettings();
  if (!settings.enabled) return undefined;
  const all = listProxies({ active: true });
  if (all.length === 0) return undefined;
  if (settings.strategy === "random") {
    return selectRandomActiveProxy();
  }
  if (settings.strategy === "round-robin") {
    const pick = all[rrIndex % all.length]!;
    rrIndex = (rrIndex + 1) % all.length;
    return pick;
  }
  // weighted (default)
  return selectNextProxy();
}

export function isProxyRoutingEnabled(): boolean {
  return getProxySettings().enabled;
}

/**
 * Build a Bun-compatible proxy URL string from a Proxy record.
 * Format: `protocol://[user:pass@]host:port`
 */
export function proxyUrl(p: Proxy): string {
  const auth =
    p.username && p.password
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
      : "";
  return `${p.protocol}://${auth}${p.host}:${p.port}`;
}

/**
 * Called when an outbound fetch returns a status that suggests the proxy IP
 * was blocked. Marks the proxy as failed and blacklists its host so the next
 * pick won't reuse it.
 */
export function markProxyFailed(proxyId: string | undefined, statusCode: number): void {
  if (!proxyId) return;
  const proxy = findProxy(proxyId);
  if (!proxy) return;
  // 403/429/503/407 → IP likely blocked
  if ([403, 429, 503, 407].includes(statusCode)) {
    handleBlockedIp(proxy.host);
  }
  rotateProxyAfterFailure(proxyId);
}

/** Stats for the dashboard. */
export function proxyStats(): { total: number; active: number; blacklisted: number } {
  const all = listProxies();
  const active = all.filter((p) => p.isActive).length;
  // We don't expose blacklist count from proxy-manager directly, but listProxies
  // filters out blacklisted hosts already; approximate using inactive count.
  const blacklisted = all.filter((p) => !p.isActive).length;
  return { total: all.length, active, blacklisted };
}
