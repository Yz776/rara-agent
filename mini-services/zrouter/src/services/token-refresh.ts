/**
 * Background token refresh sweeper.
 *
 * Runs every 60 seconds, scans all OAuth-enabled providers, and refreshes
 * any whose access token is within the refresh lead time of expiry.
 *
 * Per-credential dedup: if multiple chat requests hit an expired token
 * concurrently, only one refresh fires (the others await the same Promise).
 */

import type { OAuthCredentials } from "./oauth";
import { isDueForRefresh, refreshTokens, isCodexRefreshStale, OAUTH_CONFIGS } from "./oauth";
import * as store from "./config-store";
import * as registry from "./registry";

const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute
const REFRESH_LEAD_MS = 5 * 60 * 1000; // 5 min default

// In-flight refresh dedup: providerId → Promise<OAuthCredentials | error>
const inFlightRefreshes = new Map<string, Promise<OAuthCredentials | { error: string }>>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshSweeper(): void {
  if (sweepTimer) return;
  // Run once immediately, then on interval
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  // Don't await — fire and forget
  sweep();
}

export function stopTokenRefreshSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

async function sweep(): Promise<void> {
  for (const providerId of Object.keys(OAUTH_CONFIGS)) {
    const cred = store.findProvider(providerId);
    if (!cred || !cred.enabled || !cred.apiKey) continue;

    // Try to parse stored credentials (apiKey holds the JSON-encoded OAuthCredentials)
    let creds: OAuthCredentials;
    try {
      creds = JSON.parse(cred.apiKey) as OAuthCredentials;
    } catch {
      continue; // Not an OAuth credential (it's a plain API key)
    }
    if (!creds.accessToken || !creds.refreshToken) continue;

    if (isDueForRefresh(creds, providerId) || isCodexRefreshStale(creds, providerId)) {
      try {
        await ensureFreshToken(providerId);
      } catch (err) {
        console.error(`[tokenRefresh] ${providerId}:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

/**
 * Lazily refresh a provider's token before routing a request to it.
 * Dedupes concurrent refreshes for the same provider.
 */
export async function ensureFreshToken(providerId: string): Promise<void> {
  if (!OAUTH_CONFIGS[providerId]) return;

  const cred = store.findProvider(providerId);
  if (!cred || !cred.enabled || !cred.apiKey) return;

  let creds: OAuthCredentials;
  try {
    creds = JSON.parse(cred.apiKey) as OAuthCredentials;
  } catch {
    return;
  }
  if (!creds.accessToken || !creds.refreshToken) return;

  if (!isDueForRefresh(creds, providerId) && !isCodexRefreshStale(creds, providerId)) {
    return;
  }

  // Dedup: if a refresh is already in flight, wait for it
  if (inFlightRefreshes.has(providerId)) {
    await inFlightRefreshes.get(providerId);
    return;
  }

  const refreshPromise = (async (): Promise<OAuthCredentials | { error: string }> => {
    const result = await refreshTokens(providerId, creds.refreshToken);
    if ("error" in result) {
      console.warn(`[tokenRefresh] ${providerId} refresh failed: ${result.error}`);
      return result;
    }
    // Persist new credentials
    store.upsertProvider({
      id: providerId,
      apiKey: JSON.stringify(result),
      enabled: true,
    });
    // Invalidate cached executor so the next request rebuilds it with the new token
    registry.invalidate(providerId);
    console.log(`[tokenRefresh] ${providerId} refreshed, expires ${new Date(result.expiresAt).toISOString()}`);
    return result;
  })();

  inFlightRefreshes.set(providerId, refreshPromise);
  try {
    await refreshPromise;
  } finally {
    inFlightRefreshes.delete(providerId);
  }
}
