/**
 * /admin/api/cache, /admin/api/webhooks, /admin/api/prompts, /admin/api/smart-router, /admin/api/replay
 * — admin REST APIs for the new "cool features".
 */

import { Elysia } from "elysia";
import { authenticate } from "../middleware/auth";
import {
  getCacheSettings,
  setCacheSettings,
  getCacheStats,
  clearCache,
} from "../services/cache";
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  ALL_WEBHOOK_EVENTS,
  type WebhookEvent,
} from "../services/webhooks";
import * as templates from "../services/prompt-templates";
import {
  getSmartRouterSettings,
  setSmartRouterSettings,
} from "../services/smart-router";
import { logRequest, getRecentLogs, getDb, type ChatCompletionRequest } from "../services/db";
import * as registry from "../services/registry";
import { pickProxy, proxyUrl, isProxyRoutingEnabled } from "../services/proxy-settings";
import { getPublicAccessSettings, setPublicAccessSettings } from "../services/public-access";

function err(message: string, status: number) {
  return { error: { message, type: "admin_error", status } };
}

function authGuard(ctx: { request: Request }) {
  if (!authenticate({ request: ctx.request } as never)) {
    throw new Error("Unauthorized");
  }
}

export const featuresRoutes = new Elysia({ prefix: "/admin/api" });

const FREE_MODELS = [
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
];

featuresRoutes.get("/models/health", async (ctx) => {
  authGuard(ctx);
  const checkedAt = Date.now();
  const models = await Promise.all(FREE_MODELS.map(async (model) => {
    const started = Date.now();
    const target = model.replace(/^opencode\//, "");
    let lastStatus = 0;
    let lastDetail = "no attempt";
    let viaProxy = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const proxy = isProxyRoutingEnabled() ? pickProxy() : undefined;
      viaProxy = Boolean(proxy);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer public",
            "User-Agent": "opencode",
          },
          body: JSON.stringify({
            model: target,
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
            max_tokens: 8,
            stream: false,
          }),
          signal: controller.signal,
          ...(proxy ? { proxy: proxyUrl(proxy) } : {}),
        } as RequestInit & { proxy?: string });
        const body = await res.text();
        lastStatus = res.status;
        if (res.ok) {
          return { model, ok: true, status: res.status, latencyMs: Date.now() - started, detail: "responding", viaProxy };
        }
        try {
          const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
          lastDetail = parsed.error?.type || parsed.error?.message || body.slice(0, 160);
        } catch {
          lastDetail = body.slice(0, 160);
        }
        if (![403, 429, 503].includes(res.status)) break;
      } catch (err) {
        lastStatus = 0;
        lastDetail = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
    }
    return { model, ok: false, status: lastStatus, latencyMs: Date.now() - started, detail: lastDetail, viaProxy };
  }));
  return { checkedAt, proxyRouting: isProxyRoutingEnabled(), models };
});


// ── Cache ────────────────────────────────────────────────────────────────────
featuresRoutes.get("/public-access", (ctx) => {
  authGuard(ctx);
  return { settings: getPublicAccessSettings() };
});

featuresRoutes.post("/public-access", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as { enabled?: boolean; requestsPerHour?: number; models?: "all" | "free" };
  return { ok: true, settings: setPublicAccessSettings(body) };
});

featuresRoutes.get("/cache/settings", (ctx) => {
  authGuard(ctx);
  return { settings: getCacheSettings(), stats: getCacheStats() };
});

featuresRoutes.post("/cache/settings", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    enabled?: boolean;
    maxEntries?: number;
    ttlSeconds?: number;
    maxResponseTokens?: number;
  };
  return { ok: true, settings: setCacheSettings(body) };
});

featuresRoutes.post("/cache/clear", (ctx) => {
  authGuard(ctx);
  clearCache();
  return { ok: true };
});

featuresRoutes.get("/cache/stats", (ctx) => {
  authGuard(ctx);
  return { stats: getCacheStats() };
});

// ── Webhooks ─────────────────────────────────────────────────────────────────
featuresRoutes.get("/webhooks", (ctx) => {
  authGuard(ctx);
  return { webhooks: listWebhooks(), availableEvents: ALL_WEBHOOK_EVENTS };
});

featuresRoutes.post("/webhooks", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    url: string;
    secret?: string;
    events?: WebhookEvent[];
    enabled?: boolean;
    thresholds?: Record<string, number>;
  };
  if (!body.url) {
    ctx.set.status = 400;
    return err("url is required", 400);
  }
  if (!body.events || body.events.length === 0) {
    ctx.set.status = 400;
    return err("at least one event is required", 400);
  }
  return { ok: true, webhook: createWebhook(body) };
});

featuresRoutes.patch("/webhooks/:id", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as Partial<{
    url: string;
    secret: string;
    events: WebhookEvent[];
    enabled: boolean;
    thresholds: Record<string, number>;
  }>;
  const webhook = updateWebhook(ctx.params.id, body);
  if (!webhook) {
    ctx.set.status = 404;
    return err("Webhook not found", 404);
  }
  return { ok: true, webhook };
});

featuresRoutes.delete("/webhooks/:id", (ctx) => {
  authGuard(ctx);
  const ok = deleteWebhook(ctx.params.id);
  if (!ok) {
    ctx.set.status = 404;
    return err("Webhook not found", 404);
  }
  return { ok: true };
});

featuresRoutes.post("/webhooks/:id/test", async (ctx) => {
  authGuard(ctx);
  const result = await testWebhook(ctx.params.id);
  return result;
});

// ── Prompt Templates ─────────────────────────────────────────────────────────
featuresRoutes.get("/prompts", (ctx) => {
  authGuard(ctx);
  const category = (ctx.query as { category?: string }).category;
  return { templates: templates.listTemplates(category) };
});

featuresRoutes.post("/prompts", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    name: string;
    description?: string;
    category?: string;
    content: string;
    defaultVars?: Record<string, string>;
    tags?: string[];
    suggestedModel?: string;
  };
  if (!body.name || !body.content) {
    ctx.set.status = 400;
    return err("name and content are required", 400);
  }
  return { ok: true, template: templates.createTemplate(body) };
});

featuresRoutes.patch("/prompts/:id", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as Partial<{
    name: string;
    description: string;
    category: string;
    content: string;
    defaultVars: Record<string, string>;
    tags: string[];
    suggestedModel: string;
  }>;
  const t = templates.updateTemplate(ctx.params.id, body);
  if (!t) {
    ctx.set.status = 404;
    return err("Template not found", 404);
  }
  return { ok: true, template: t };
});

featuresRoutes.delete("/prompts/:id", (ctx) => {
  authGuard(ctx);
  const ok = templates.deleteTemplate(ctx.params.id);
  if (!ok) {
    ctx.set.status = 404;
    return err("Template not found", 404);
  }
  return { ok: true };
});

featuresRoutes.post("/prompts/:id/render", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as { vars?: Record<string, string> };
  const t = templates.getTemplate(ctx.params.id);
  if (!t) {
    ctx.set.status = 404;
    return err("Template not found", 404);
  }
  return { ok: true, content: templates.renderTemplate(t, body.vars), variables: templates.extractVariables(t.content) };
});

// ── Smart Router ─────────────────────────────────────────────────────────────
featuresRoutes.get("/smart-router", (ctx) => {
  authGuard(ctx);
  return { settings: getSmartRouterSettings() };
});

featuresRoutes.post("/smart-router", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as Partial<{
    enabled: boolean;
    defaultStrategy: "cheapest" | "fastest" | "balanced" | "highest-quality";
    excludedModels: string[];
    preferredProviders: string[];
  }>;
  return { ok: true, settings: setSmartRouterSettings(body) };
});

// ── Request Replay ───────────────────────────────────────────────────────────
featuresRoutes.post("/replay/:logId", async (ctx) => {
  authGuard(ctx);
  const db = getDb();
  const log = db.prepare("SELECT * FROM request_logs WHERE id = ?").get(ctx.params.logId) as
    | Record<string, unknown>
    | undefined;
  if (!log) {
    ctx.set.status = 404;
    return err("Log not found", 404);
  }
  // Note: the original request body isn't stored in the log — we only have the
  // model + token counts. For a true replay we'd need to also store the
  // messages, which we don't do for privacy/size reasons. So this endpoint
  // is a placeholder that returns the log's metadata, allowing the dashboard
  // to pre-fill a playground request with the same model.
  return {
    ok: true,
    replay: {
      model: log.model as string,
      providerId: log.provider_id as string,
      originalStatusCode: log.status_code as number,
      originalLatencyMs: log.latency_ms as number,
      originalTokens: {
        prompt: log.prompt_tokens as number,
        completion: log.completion_tokens as number,
        total: log.total_tokens as number,
      },
      message: "Original request body not stored. Use the Playground to re-run with the same model.",
    },
  };
});
