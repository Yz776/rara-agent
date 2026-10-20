/**
 * fetchWithRetry — wraps fetch() with exponential backoff for transient errors.
 *
 * - 429 / 5xx → retry up to `maxRetries` times.
 * - Respects Retry-After / x-ratelimit-reset-* headers.
 * - Surfaces the final Response (ok or not) so callers can inspect status/body.
 *
 * Auto Proxy Routed: when the proxy-routing setting is enabled (see
 * services/proxy-settings), every fetch is wrapped with a proxy from the
 * pool. On 403/429/503/407 the current proxy is rotated and the request is
 * retried with a different proxy (up to `maxRetries` times).
 */

import {
  isProxyRoutingEnabled,
  getProxyMode,
  pickProxy,
  proxyUrl,
  markProxyFailed,
} from "../services/proxy-settings";

const MAX_RETRY_AFTER_MS = 10_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /overloaded/i,
  /concurrency/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];

// Status codes that suggest the proxy IP was blocked; we rotate the proxy
// before retrying when auto-proxy-routing is enabled.
const PROXY_ROTATE_STATUSES = new Set([403, 429, 503, 407]);

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  proxy?: string;
}

export async function fetchWithRetry(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  maxRetries = 4
): Promise<Response> {
  const mode = getProxyMode();
  const proxyOn = mode !== "off";
  // fallback: start direct; the pool joins only after a quota/IP-block hit
  let currentProxy = mode === "always" ? pickProxy() : undefined;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const opts: FetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        ...headers,
      },
    };
    if (body !== undefined && body !== null) {
      opts.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    if (currentProxy) opts.proxy = proxyUrl(currentProxy);

    try {
      const res = await fetch(url, opts as RequestInit & { proxy?: string });

      // If proxy-routing is on and the response looks like an IP block,
      // rotate the proxy and retry with a fresh one.
      if (proxyOn && PROXY_ROTATE_STATUSES.has(res.status)) {
        markProxyFailed(currentProxy?.id, res.status);
        // Drain so the connection can be reused / closed cleanly
        await res.text().catch(() => undefined);
        if (attempt < maxRetries) {
          // fallback: direct attempt just got blocked — enter the pool now
          if (mode === "fallback" && !currentProxy) {
            currentProxy = pickProxy();
            if (currentProxy) continue;
          } else {
            // Keep going even when the pool repeats: a fresh exit IP often clears 429.
            const next = pickProxy();
            currentProxy = next ?? currentProxy;
            if (currentProxy) continue;
          }
        }
        return res;
      }

      if (res.ok || !TRANSIENT_STATUSES.has(res.status)) {
        return res;
      }

      // Transient — compute delay
      const retryAfter = parseRetryHeaders(res.headers);
      const delay =
        retryAfter !== null
          ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
          : backoffMs(attempt);

      if (attempt === maxRetries) return res;

      // Drain body so the connection can be reused
      await res.text().catch(() => undefined);
      await sleep(delay);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;
      const isTransient = TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
      // Network errors often mean the proxy itself is dead — rotate it.
      if (proxyOn && currentProxy) {
        markProxyFailed(currentProxy.id, 0);
        currentProxy = pickProxy();
      }
      if (!isTransient || attempt === maxRetries) throw lastError;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError ?? new Error("fetchWithRetry: exhausted retries");
}

export function isToolCallingNotSupportedError(errorText: string): boolean {
  return /tool.?calling.*not\s+supported|not\s+support.*tool|tools?\s+not\s+supported|does\s+not\s+support\s+(function\s+)?tool/i.test(
    errorText
  );
}

function backoffMs(attempt: number): number {
  return Math.min(400 * Math.pow(2, attempt), 2500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryHeaders(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const ms = parseRetryAfter(retryAfter);
    if (ms !== null) return ms;
  }
  const resetAfter = headers.get("x-ratelimit-reset-after");
  if (resetAfter) {
    const seconds = parseInt(resetAfter, 10);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const ts = parseInt(reset, 10) * 1000;
    const diff = ts - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}

function parseRetryAfter(value: string): number | null {
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const diff = date.getTime() - Date.now();
    return diff > 0 ? diff : null;
  }
  return null;
}
