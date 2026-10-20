/**
 * /admin/api — admin REST API extended with:
 *  - Virtual API keys (with rate limits + quotas)
 *  - Logs / observability (usage, model breakdown, recent requests)
 *  - Combos management
 *  - Token saver settings
 *  - OAuth connection status
 */

import { Elysia } from "elysia";
import * as store from "../services/config-store";
import { PROVIDER_CATALOG, findProviderDef, listCustomProviderDefs, getCustomProviderAuth } from "../providers/catalog";
import * as registry from "../services/registry";
import * as dbModule from "../services/db";
import { getDb } from "../services/db";
import * as combosModule from "../services/combos";
import { authenticate as _unused_authenticate, isSessionAdmin, isAdmin } from "../middleware/auth";
void _unused_authenticate; // keep side-effect import ordering stable
import { OAUTH_CONFIGS } from "../services/oauth";
import { DEFAULT_TOKEN_SAVER_SETTINGS } from "../services/token-saver";
import * as poolSvc from "../services/key-pool";

function err(message: string, status: number) {
  return { error: { message, type: "admin_error", status } };
}

function authGuard(ctx: { request: Request }) {
  if (!isAdmin({ request: ctx.request } as never)) {
    throw new Error("Unauthorized — admin access required");
  }
}

export const adminRoutes = new Elysia({ prefix: "/admin/api" });

// ── Settings & Management ───────────────────────────────────────────
adminRoutes.get("/settings/stats", ({ request }) => {
  if (!isAdmin({ request } as never)) {
    return new Response(JSON.stringify(err("Unauthorized — admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  try {
    const summary = dbModule.getUsageSummary();
    
    return {
      success: true,
      data: {
        totalRequests: summary.totalRequests,
        totalTokens: summary.totalTokens,
        totalCost: summary.estimatedCost,
        avgLatency: summary.avgLatencyMs,
      },
    };
  } catch (e) {
    return err(String(e), 500);
  }
});

// Reset all logs
adminRoutes.delete("/logs/clear", ({ request }) => {
  if (!isSessionAdmin({ request })) {
    return new Response(JSON.stringify(err("Admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  try {
    const db = getDb();
    db.run("DELETE FROM request_logs");
    return { success: true };
  } catch (e) {
    return err(String(e), 500);
  }
});

// Reset all pool entries (replaces the old virtual-keys reset-all route).
adminRoutes.post("/pool/reset-all", ({ request }) => {
  if (!isSessionAdmin({ request })) {
    return new Response(JSON.stringify(err("Admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const all = poolSvc.listEntries();
    for (const e of all) poolSvc.deleteEntry(e.id);
    return { success: true, removed: all.length };
  } catch (e) {
    return err(String(e), 500);
  }
});

// Factory reset (complete system reset except config)
adminRoutes.post("/settings/factory-reset", ({ request }) => {
  if (!isSessionAdmin({ request })) {
    return new Response(JSON.stringify(err("Admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  try {
    const db = getDb();
    // Clear logs
    db.run("DELETE FROM request_logs");
    // Reset token saver settings
    db.run("DELETE FROM settings WHERE key LIKE '%token%'");
    // Reset all pool entries (the new credential store)
    try {
      const all = poolSvc.listEntries();
      for (const e of all) poolSvc.deleteEntry(e.id);
    } catch { /* ignore */ }
    return { success: true };
  } catch (e) {
    return err(String(e), 500);
  }
});

// Export configuration
adminRoutes.get("/settings/export-config", ({ request }) => {
  if (!isAdmin({ request } as never)) {
    return new Response(JSON.stringify(err("Unauthorized — admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  try {
    const config = {
      providers: store.listProviders(),
      adminKeys: store.listAdminKeys(),
      combos: combosModule.listCombos(),
      fallbacks: store.listFallbacks(),
      exportedAt: Date.now(),
      version: "2.0.0",
    };
    
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    return new Response(blob, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="krouter-config-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
});

// Export logs as CSV
adminRoutes.get("/logs/export-csv", ({ request }) => {
  if (!isAdmin({ request } as never)) {
    return new Response(JSON.stringify(err("Unauthorized — admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT 
        date(created_at / 1000, 'unixepoch') as date,
        provider_id,
        model,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        status_code,
        latency_ms,
        estimated_cost
      FROM request_logs
      ORDER BY created_at DESC
      LIMIT 10000
    `).all();
    
    let csv = "Date,Provider,Model,Prompt Tokens,Completion Tokens,Total Tokens,Status,Latency(ms),Cost\n";
    rows.forEach(row => {
      csv += `${row.date},${row.provider_id},${row.model},${row.prompt_tokens},${row.completion_tokens},${row.total_tokens},${row.status_code},${Math.round(row.latency_ms)},${row.estimated_cost}\n`;
    });
    
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    return new Response(blob, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="krouter-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return err(String(e), 500);
  }
});

// ── MCP Tools Management ───────────────────────────────────────────
adminRoutes.get("/mcp/tools/list", ({ request }) => {
  if (!isAdmin({ request } as never)) {
    return new Response(JSON.stringify(err("Unauthorized — admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  return {
    success: true,
    tools: [
      { name: "file-system", description: "Safe file operations with path validation", enabled: true, dangerLevel: "low" },
      { name: "search", description: "Web search integration", enabled: false, dangerLevel: "low" },
      { name: "calculator", description: "Mathematical computations", enabled: true, dangerLevel: "none" },
      { name: "database", description: "Secure SQL queries", enabled: false, dangerLevel: "medium" },
      { name: "browser", description: "Browser automation", enabled: false, dangerLevel: "medium" },
      { name: "ssh", description: "Remote SSH execution", enabled: false, dangerLevel: "high", hidden: true }, // Hidden dangerous tool
      { name: "system-command", description: "Execute system commands", enabled: false, dangerLevel: "critical", hidden: true }, // Hidden dangerous tool
      { name: "network-access", description: "Network requests", enabled: false, dangerLevel: "medium", hidden: true }, // Hidden dangerous tool
    ],
  };
});

adminRoutes.post("/mcp/tools/enable/:toolName", ({ params, request }) => {
  if (!isSessionAdmin({ request })) {
    return new Response(JSON.stringify(err("Admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  const { toolName } = params;
  const validTools = ["file-system", "search", "calculator", "database", "browser"];
  const hiddenDangerousTools = ["ssh", "system-command", "network-access"];
  
  if (hiddenDangerousTools.includes(toolName)) {
    return new Response(JSON.stringify({ error: "This tool is disabled for security reasons" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  if (!validTools.includes(toolName)) {
    return new Response(JSON.stringify({ error: "Invalid tool name" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  // Store enabled tools in settings
  const db = getDb();
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'mcp_enabled_tools'").get();
  const currentTools = existing ? JSON.parse(existing.value) : [];
  
  if (!currentTools.includes(toolName)) {
    currentTools.push(toolName);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("mcp_enabled_tools", JSON.stringify(currentTools));
  }
  
  return { success: true, tool: toolName };
});

adminRoutes.post("/mcp/test-connection", async ({ body, request }) => {
  if (!isSessionAdmin({ request })) {
    return new Response(JSON.stringify(err("Admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  const { endpoint } = body;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let connected = false;
    let status = 0;
    try {
      const response = await fetch(`${endpoint}/health`, { signal: controller.signal });
      connected = response.ok;
      status = response.status;
    } finally {
      clearTimeout(timeout);
    }
    return { connected, status };
  } catch (e) {
    return { connected: false, error: e instanceof Error ? e.message : String(e) };
  }
});

adminRoutes.patch("/mcp/config", async ({ body, request }) => {
  if (!isSessionAdmin({ request })) {
    return new Response(JSON.stringify(err("Admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  const { endpoint, timeout } = body;
  
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run("mcp_endpoint", endpoint || "");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run("mcp_timeout", String(timeout || 10));
  
  return { success: true };
});

// ── Bootstrap check ──────────────────────────────────────────────────
adminRoutes.get("/status", () => {
  const poolEntries = poolSvc.listEntries();
  return {
    bootstrap: store.listAdminKeys().length === 0,
    adminKeyCount: store.listAdminKeys().length,
    providerCount: store.listProviders().filter((p) => p.enabled).length,
    poolEntryCount: poolEntries.length,
    poolActiveCount: poolEntries.filter((e) => e.enabled && e.status === "active").length,
    poolCooldownCount: poolEntries.filter((e) => e.status === "cooldown").length,
  };
});

// ── Admin key management ────────────────────────────────────────────────────
adminRoutes.get("/keys", ({ request }) => {
  if (!isAdmin({ request } as never)) {
    return new Response(JSON.stringify(err("Unauthorized — admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return { keys: store.listAdminKeys() };
});

adminRoutes.post("/keys", (ctx) => {
  const body = (ctx.body ?? {}) as { name?: string };
  if (store.listAdminKeys().length === 0) {
    const key = store.createAdminKey(body.name ?? "bootstrap");
    return { key, message: "Bootstrap admin key created. Save it — it will not be shown again." };
  }
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const key = store.createAdminKey(body.name ?? `key-${Date.now()}`);
  return { key };
});

adminRoutes.delete("/keys/:id", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  store.deleteAdminKey(ctx.params.id);
  return { ok: true };
});

// ── Provider management ──────────────────────────────────────────────────────
adminRoutes.get("/providers", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const creds = store.listProviders();
  // Merge built-in catalog with user-defined custom providers
  const allDefs = [...PROVIDER_CATALOG, ...listCustomProviderDefs()];
  const poolByProvider = new Map<string, { total: number; active: number; cooldown: number; disabled: number }>();
  for (const stat of poolSvc.poolStats()) {
    poolByProvider.set(stat.providerId, {
      total: stat.total,
      active: stat.active,
      cooldown: stat.cooldown,
      disabled: stat.disabled,
    });
  }
  return {
    providers: allDefs.map((def) => {
      const cred = creds.find((c) => c.id === def.id);
      const customDef = getCustomProviderAuth(def.id);
      const ps = poolByProvider.get(def.id);
      return {
        id: def.id,
        name: def.name,
        category: def.category,
        protocol: def.protocol,
        baseUrl: def.baseUrl,
        webUrl: def.webUrl,
        alias: def.alias,
        requiresApiKey: def.requiresApiKey,
        supportsCustomUrl: def.supportsCustomUrl,
        statusMessage: def.statusMessage,
        configured: Boolean(cred) || (ps?.active ?? 0) > 0,
        enabled: cred?.enabled ?? (ps?.active ?? 0) > 0,
        hasApiKey: Boolean(cred?.apiKey) || (ps?.total ?? 0) > 0,
        baseUrlOverride: cred?.baseUrl,
        models: def.models,
        isCustom: Boolean(customDef),
        customAuthScheme: customDef?.authScheme,
        pool: ps ?? { total: 0, active: 0, cooldown: 0, disabled: 0 },
      };
    }),
  };
});

adminRoutes.post("/providers", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const body = ctx.body as {
    id: string;
    apiKey?: string;
    baseUrl?: string;
    enabled?: boolean;
  };
  const def = findProviderDef(body.id);
  if (!def) {
    ctx.set.status = 404;
    return err(`Unknown provider: ${body.id}`, 404);
  }
  const cred = store.upsertProvider({
    id: body.id,
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
    enabled: body.enabled ?? true,
  });
  registry.invalidate(def.id);
  return { ok: true, credential: { ...cred, apiKey: cred.apiKey ? "***" : "" } };
});

adminRoutes.delete("/providers/:id", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  store.deleteProvider(ctx.params.id);
  registry.invalidate(ctx.params.id);
  return { ok: true };
});

// ── Custom provider management (user-defined providers) ─────────────────────
adminRoutes.get("/custom-providers", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  return { providers: store.listCustomProviders() };
});

adminRoutes.post("/custom-providers", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const body = (ctx.body ?? {}) as {
    id?: string;
    name?: string;
    baseUrl?: string;
    authScheme?: "bearer" | "x-api-key" | "custom-header" | "none";
    authHeaderName?: string;
    authHeaderPrefix?: string;
    models?: Array<{ id: string; capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean; reasoning?: boolean } }>;
    fetchModelsLive?: boolean;
  };
  if (!body.id || !body.name || !body.baseUrl) {
    ctx.set.status = 400;
    return err("id, name, and baseUrl are required", 400);
  }
  // Validate id: must be lowercase, no slashes, can't collide with built-ins
  const id = String(body.id).toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    ctx.set.status = 400;
    return err("id must be lowercase letters/digits/_/- only", 400);
  }
  if (PROVIDER_CATALOG.some((p) => p.id === id)) {
    ctx.set.status = 409;
    return err(`Provider id "${id}" collides with a built-in provider`, 409);
  }
  const authScheme = body.authScheme ?? "bearer";
  if (!["bearer", "x-api-key", "custom-header", "none"].includes(authScheme)) {
    ctx.set.status = 400;
    return err("authScheme must be bearer | x-api-key | custom-header | none", 400);
  }
  if (authScheme === "custom-header" && !body.authHeaderName) {
    ctx.set.status = 400;
    return err("authHeaderName is required when authScheme=custom-header", 400);
  }
  const saved = store.upsertCustomProvider({
    id,
    name: String(body.name).trim(),
    baseUrl: String(body.baseUrl).trim().replace(/\/$/, ""),
    authScheme,
    authHeaderName: body.authHeaderName?.trim() || undefined,
    authHeaderPrefix: body.authHeaderPrefix?.trim() || undefined,
    models: Array.isArray(body.models) ? body.models : [],
    fetchModelsLive: body.fetchModelsLive ?? false,
  });
  // Invalidate cache so the next request picks up the new def
  registry.invalidate(id);
  return { ok: true, provider: saved };
});

adminRoutes.delete("/custom-providers/:id", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  store.deleteCustomProvider(ctx.params.id);
  registry.invalidate(ctx.params.id);
  return { ok: true };
});

// ── Provider testing ────────────────────────────────────────────────────────
adminRoutes.post("/providers/:id/test", async (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const id = ctx.params.id;
  const def = findProviderDef(id);
  if (!def) {
    ctx.set.status = 404;
    return err(`Unknown provider: ${id}`, 404);
  }
  registry.invalidate(id);
  try {
    const { buildExecutor } = await import("../providers/catalog");
    const cred = store.findProvider(id);
    if (!cred || (def.requiresApiKey && !cred.apiKey)) {
      return { ok: false, error: def.statusMessage ?? "Missing credential" };
    }
    const instance = buildExecutor(def, cred.apiKey, cred.baseUrl) as {
      listModels: () => Promise<unknown[]>;
    };
    const models = await instance.listModels();
    return { ok: true, modelsCount: models.length, sample: models.slice(0, 3) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
});

// ── Fallback rules ──────────────────────────────────────────────────────────
adminRoutes.get("/fallbacks", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  return { fallbacks: store.listFallbacks() };
});

adminRoutes.post("/fallbacks", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const body = ctx.body as {
    sourceModel: string;
    targetModel: string;
    triggerStatus?: number[];
    enabled?: boolean;
  };
  if (!body.sourceModel || !body.targetModel) {
    ctx.set.status = 400;
    return err("sourceModel and targetModel are required", 400);
  }
  const fb = store.createFallback({
    sourceModel: body.sourceModel,
    targetModel: body.targetModel,
    triggerStatus: body.triggerStatus ?? [429, 503],
    enabled: body.enabled ?? true,
  });
  return { ok: true, fallback: fb };
});

adminRoutes.delete("/fallbacks/:id", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  store.deleteFallback(ctx.params.id);
  return { ok: true };
});

// ── Combos ─────────────────────────────────────────────────────────────────
adminRoutes.get("/combos", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  return { combos: combosModule.listCombos() };
});

adminRoutes.post("/combos", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const body = (ctx.body ?? {}) as {
    name: string;
    strategy?: "fallback" | "round-robin";
    models: string[];
    stickyLimit?: number;
  };
  if (!body.name || !Array.isArray(body.models) || body.models.length === 0) {
    ctx.set.status = 400;
    return err("name and models[] are required", 400);
  }
  const combo = combosModule.createCombo({
    name: body.name,
    strategy: body.strategy ?? "fallback",
    models: body.models,
    stickyLimit: body.stickyLimit ?? 1,
  });
  return { ok: true, combo };
});

adminRoutes.delete("/combos/:id", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  combosModule.deleteCombo(ctx.params.id);
  return { ok: true };
});

// ── Logs / observability ───────────────────────────────────────────────────
adminRoutes.get("/usage", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const since = Number(ctx.query.since ?? 0);
  return {
    summary: dbModule.getUsageSummary(since),
    byModel: dbModule.getUsageByModel(50),
  };
});

adminRoutes.get("/logs", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const limit = Number(ctx.query.limit ?? 100);
  return { logs: dbModule.getRecentLogs(limit) };
});

// ── Token saver settings ───────────────────────────────────────────────────
adminRoutes.get("/token-saver", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const raw = dbModule.getSetting("token_saver", JSON.stringify(DEFAULT_TOKEN_SAVER_SETTINGS));
  try {
    return { settings: { ...DEFAULT_TOKEN_SAVER_SETTINGS, ...JSON.parse(raw) } };
  } catch {
    return { settings: DEFAULT_TOKEN_SAVER_SETTINGS };
  }
});

adminRoutes.post("/token-saver", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  const body = ctx.body;
  dbModule.setSetting("token_saver", JSON.stringify(body));
  return { ok: true };
});

// ── OAuth provider list ─────────────────────────────────────────────────────
adminRoutes.get("/oauth/providers", (ctx) => {
  if (!isAdmin(ctx as never)) {
    ctx.set.status = 403;
    return err("Unauthorized — admin access required", 403);
  }
  return {
    providers: Object.keys(OAUTH_CONFIGS).map((id) => ({
      id,
      authorizeUrl: OAUTH_CONFIGS[id]!.authorizeUrl,
      scopes: OAUTH_CONFIGS[id]!.scopes,
    })),
  };
});
