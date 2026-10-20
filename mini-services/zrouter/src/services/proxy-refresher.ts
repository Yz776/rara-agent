/**
 * Auto Proxy Pool Refresh — background scheduler.
 *
 * Public proxies rot fast (many die within hours). This service keeps the
 * pool useful without manual clicks: every `intervalMinutes` it scrapes fresh
 * public proxies, health-checks the whole pool against the real provider, and
 * removes the dead ones. It never routes traffic — whether requests use the
 * pool is still controlled by the separate "auto proxy routed" setting.
 *
 * Settings live in the main DB settings table (key: proxy_auto_refresh) so
 * they survive restarts. The next-run timer re-reads settings every cycle, so
 * interval/enabled changes apply without a restart.
 */

import { getSetting, setSetting } from "./db";
import {
  scrapePublicProxies,
  bulkAddProxies,
  checkAllProxyHealth,
  removeInactiveProxies,
} from "./proxy-manager";
import { proxyStats } from "./proxy-settings";

export interface AutoRefreshSettings {
  enabled: boolean;
  intervalMinutes: number;
}

export interface AutoRefreshLastRun {
  at: number;
  scraped: number;
  checked: number;
  healthy: number;
  removed: number;
  ok: boolean;
  error?: string;
}

const SETTINGS_KEY = "proxy_auto_refresh";
const LAST_RUN_KEY = "proxy_auto_refresh_last";

const DEFAULT_SETTINGS: AutoRefreshSettings = { enabled: false, intervalMinutes: 60 };
const MIN_INTERVAL = 10; // public scrapers + health probes are heavy; don't hammer

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let loggedDisabled = false;

export function getAutoRefreshSettings(): AutoRefreshSettings {
  try {
    const parsed = JSON.parse(getSetting(SETTINGS_KEY, JSON.stringify(DEFAULT_SETTINGS))) as Partial<AutoRefreshSettings>;
    return {
      enabled: parsed.enabled ?? false,
      intervalMinutes: Math.max(MIN_INTERVAL, Math.min(1440, parsed.intervalMinutes ?? 60)),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setAutoRefreshSettings(s: Partial<AutoRefreshSettings>): AutoRefreshSettings {
  const current = getAutoRefreshSettings();
  const next: AutoRefreshSettings = {
    enabled: s.enabled ?? current.enabled,
    intervalMinutes: Math.max(MIN_INTERVAL, Math.min(1440, s.intervalMinutes ?? current.intervalMinutes)),
  };
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  scheduleNext(); // re-arm with the new interval / stop if disabled
  return next;
}

export function getLastRun(): AutoRefreshLastRun | null {
  try {
    return JSON.parse(getSetting(LAST_RUN_KEY, "null")) as AutoRefreshLastRun | null;
  } catch {
    return null;
  }
}

/** Scrape → health-check → prune. Shared by the manual route and the scheduler. */
export async function refreshPool(): Promise<AutoRefreshLastRun> {
  let result: AutoRefreshLastRun;
  try {
    let scraped = 0;
    try {
      const found = await scrapePublicProxies();
      await bulkAddProxies(
        found.map((p) => ({
          ...p,
          isActive: false, // the health check right after decides who lives
          uptimeScore: 0,
          checkCount: 0,
          failedCount: 0,
          isAnonymous: false,
          responseTimeMs: 0,
          lastCheckedAt: Date.now(),
        }))
      );
      scraped = found.length;
    } catch {
      // Scrape sources can be down; keep going with the existing pool.
    }
    const report = await checkAllProxyHealth();
    const removed = removeInactiveProxies();
    result = {
      at: Date.now(),
      scraped,
      checked: report.checked,
      healthy: report.healthy,
      removed,
      ok: true,
    };
  } catch (err) {
    result = {
      at: Date.now(),
      scraped: 0,
      checked: 0,
      healthy: 0,
      removed: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  setSetting(LAST_RUN_KEY, JSON.stringify(result));
  const stats = proxyStats();
  console.log(
    `[proxy-refresher] scraped=${result.scraped} checked=${result.checked} healthy=${result.healthy} removed=${result.removed} pool(active=${stats.active} total=${stats.total})`
  );
  return result;
}

function scheduleNext(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const settings = getAutoRefreshSettings();
  if (!settings.enabled) {
    if (!loggedDisabled) {
      console.log("[proxy-refresher] auto refresh disabled");
      loggedDisabled = true;
    }
    return;
  }
  loggedDisabled = false;
  timer = setTimeout(async () => {
    if (!running) {
      running = true;
      try {
        await refreshPool();
      } finally {
        running = false;
      }
    }
    scheduleNext(); // re-read settings so interval changes apply next cycle
  }, settings.intervalMinutes * 60 * 1000);
  console.log(`[proxy-refresher] next run in ${settings.intervalMinutes}m`);
}

/** Called once at gateway boot. */
export function startProxyRefresher(): void {
  scheduleNext();
}
