/**
 * /admin/api/proxies and /admin/api/proxy-settings — admin REST API for the
 * auto-proxy-routed feature.
 *
 *   GET    /admin/api/proxies                — list all proxies
 *   POST   /admin/api/proxies                — add a proxy
 *   DELETE /admin/api/proxies/:id            — remove a proxy
 *   POST   /admin/api/proxies/:id/validate   — test a proxy
 *   POST   /admin/api/proxies/validate-all   — test every proxy
 *   POST   /admin/api/proxies/scrape         — scrape public proxies
 *   GET    /admin/api/proxy-settings         — get proxy-routing settings + stats
 *   POST   /admin/api/proxy-settings         — update settings
 */

import { Elysia } from "elysia";
import { authenticate } from "../middleware/auth";
import {
  addProxy,
  removeProxy,
  findProxy,
  listProxies,
  validateProxy,
  scrapePublicProxies,
  bulkAddProxies,
  checkAllProxyHealth,
  removeInactiveProxies,
} from "../services/proxy-manager";
import {
  getProxySettings,
  setProxySettings,
  proxyStats,
} from "../services/proxy-settings";
import {
  getAutoRefreshSettings,
  setAutoRefreshSettings,
  getLastRun,
  refreshPool,
} from "../services/proxy-refresher";

function err(message: string, status: number) {
  return { error: { message, type: "proxy_error", status } };
}

function authGuard(ctx: { request: Request }) {
  if (!authenticate({ request: ctx.request } as never)) {
    throw new Error("Unauthorized");
  }
}

export const proxyRoutes = new Elysia({ prefix: "/admin/api" });

// ── Proxy settings ───────────────────────────────────────────────────────────
proxyRoutes.get("/proxy-settings", (ctx) => {
  authGuard(ctx);
  return { settings: getProxySettings(), stats: proxyStats() };
});

proxyRoutes.post("/proxy-settings", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    enabled?: boolean;
    strategy?: "weighted" | "random" | "round-robin";
    mode?: "off" | "fallback" | "always";
  };
  const next = setProxySettings({
    enabled: body.enabled,
    strategy: body.strategy,
    mode: body.mode,
  });
  return { ok: true, settings: next };
});

// ── Proxy CRUD ───────────────────────────────────────────────────────────────
proxyRoutes.get("/proxies", (ctx) => {
  authGuard(ctx);
  return { proxies: listProxies() };
});

proxyRoutes.post("/proxies", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    host?: string;
    port?: number;
    protocol?: "http" | "https" | "socks4" | "socks5";
    username?: string;
    password?: string;
    country?: string;
  };
  if (!body.host || !body.port) {
    ctx.set.status = 400;
    return err("host and port are required", 400);
  }
  const protocol = body.protocol ?? "http";
  if (!["http", "https", "socks4", "socks5"].includes(protocol)) {
    ctx.set.status = 400;
    return err("protocol must be http | https | socks4 | socks5", 400);
  }
  const proxy = addProxy({
    host: String(body.host).trim(),
    port: Number(body.port),
    protocol,
    username: body.username,
    password: body.password,
    country: body.country,
    lastCheckedAt: Date.now(),
    responseTimeMs: 0,
    isActive: true,
    isAnonymous: false,
    uptimeScore: 0.5,
    checkCount: 0,
    failedCount: 0,
  });
  return { ok: true, proxy };
});

proxyRoutes.delete("/proxies/:id", (ctx) => {
  authGuard(ctx);
  removeProxy(ctx.params.id);
  return { ok: true };
});

// ── Validate ─────────────────────────────────────────────────────────────────
proxyRoutes.post("/proxies/:id/validate", async (ctx) => {
  authGuard(ctx);
  const proxy = findProxy(ctx.params.id);
  if (!proxy) {
    ctx.set.status = 404;
    return err(`Proxy not found: ${ctx.params.id}`, 404);
  }
  const ok = await validateProxy(proxy);
  const updated = findProxy(ctx.params.id);
  return {
    ok,
    responseTimeMs: updated?.responseTimeMs ?? 0,
    isActive: updated?.isActive ?? false,
  };
});

proxyRoutes.post("/proxies/validate-all", async (ctx) => {
  authGuard(ctx);
  const proxies = listProxies();
  let valid = 0;
  let invalid = 0;
  // Validate sequentially to avoid overloading upstream
  for (const p of proxies) {
    const ok = await validateProxy(p);
    if (ok) valid++; else invalid++;
  }
  return { ok: true, valid, invalid, total: proxies.length };
});

// ── Scrape ───────────────────────────────────────────────────────────────────
proxyRoutes.post("/proxies/health", async (ctx) => {
  authGuard(ctx);
  const report = await checkAllProxyHealth();
  const { results: _results, ...summary } = report;
  return { ok: true, ...summary };
});

proxyRoutes.post("/proxies/prune", (ctx) => {
  authGuard(ctx);
  const removed = removeInactiveProxies();
  return { ok: true, removed, stats: proxyStats() };
});

// One-click pool refresh (same pipeline the background scheduler runs):
// scrape public proxies, health-check the pool against the real provider,
// remove the dead ones.
proxyRoutes.post("/proxies/refresh", async (ctx) => {
  authGuard(ctx);
  const result = await refreshPool();
  return { ok: result.ok, ...result, stats: proxyStats() };
});

// ── Auto refresh settings ────────────────────────────────────────────────────
proxyRoutes.get("/proxy-auto-refresh", (ctx) => {
  authGuard(ctx);
  return { settings: getAutoRefreshSettings(), lastRun: getLastRun() };
});

proxyRoutes.post("/proxy-auto-refresh", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as { enabled?: boolean; intervalMinutes?: number };
  return { ok: true, settings: setAutoRefreshSettings(body), lastRun: getLastRun() };
});

proxyRoutes.post("/proxies/scrape", async (ctx) => {
  authGuard(ctx);
  try {
    const scraped = await scrapePublicProxies();
    // Insert with a default state
    await bulkAddProxies(
      scraped.map((p) => ({
        ...p,
        isActive: false, // start inactive until validated
        uptimeScore: 0,
        checkCount: 0,
        failedCount: 0,
        isAnonymous: false,
        responseTimeMs: 0,
        lastCheckedAt: Date.now(),
      }))
    );
    return { ok: true, added: scraped.length };
  } catch (e) {
    return {
      ok: false,
      added: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});
