/**
 * /admin/api/tokens — Token Management & Analytics API.
 *
 * Endpoints:
 *   GET  /tokens/analytics        — cost summary, trend, by-model, top consumers
 *   GET  /tokens/forecast         — 7-day cost/token forecast
 *   GET  /tokens/budget-alerts    — virtual keys over 80%/95% of their budget
 *   GET  /tokens/export           — CSV export of all request logs with cost
 *   GET  /tokens/templates        — list quota templates
 *   POST /tokens/templates/:id/apply/:vkeyId  — apply template to virtual key
 *   GET  /tokens/pricing          — list all known pricing (defaults + overrides)
 *   POST /tokens/pricing/:model   — set custom pricing override
 *   DELETE /tokens/pricing/:model — clear custom override
 */

import { Elysia } from "elysia";
import { authenticate } from "../middleware/auth";
import * as db from "../services/db";
import {
  listAllPricing,
  setPricingOverride,
  clearPricingOverride,
  type ModelPricing,
} from "../services/pricing";

function err(message: string, status: number) {
  return { error: { message, type: "tokens_error", status } };
}

function authGuard(ctx: { request: Request }) {
  if (!authenticate({ request: ctx.request } as never)) {
    throw new Error("Unauthorized");
  }
}

export const tokenRoutes = new Elysia({ prefix: "/admin/api/tokens" });

// ── Analytics ────────────────────────────────────────────────────────────────
tokenRoutes.get("/analytics", (ctx) => {
  authGuard(ctx);
  return {
    summary: db.getCostSummary(),
    trend: db.getCostTrend(30),
    byModel: db.getCostByModel(20),
    topConsumers: db.getTopConsumers(10),
  };
});

// ── Forecast ─────────────────────────────────────────────────────────────────
tokenRoutes.get("/forecast", (ctx) => {
  authGuard(ctx);
  return { forecast: db.getUsageForecast(7) };
});

// ── Budget alerts ────────────────────────────────────────────────────────────
tokenRoutes.get("/budget-alerts", (ctx) => {
  authGuard(ctx);
  return { alerts: db.getBudgetAlerts() };
});

// ── Export ───────────────────────────────────────────────────────────────────
tokenRoutes.get("/export", (ctx) => {
  authGuard(ctx);
  try {
    const dbh = db.getDb();
    const rows = dbh.prepare(`
      SELECT
        date(created_at / 1000, 'unixepoch') as date,
        provider_id,
        model,
        api_key_id,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        estimated_cost,
        status_code,
        latency_ms,
        fallback_occurred
      FROM request_logs
      ORDER BY created_at DESC
      LIMIT 50000
    `).all() as Record<string, unknown>[];
    let csv = "Date,Provider,Model,APIKeyId,PromptTokens,CompletionTokens,TotalTokens,CostUSD,Status,LatencyMs,Fallback\n";
    for (const r of rows) {
      csv += [
        r.date,
        r.provider_id,
        r.model,
        r.api_key_id ?? "",
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        r.estimated_cost,
        r.status_code,
        r.latency_ms,
        r.fallback_occurred ? "yes" : "no",
      ].join(",") + "\n";
    }
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="krouter-tokens-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
});

// ── Quota templates ──────────────────────────────────────────────────────────
tokenRoutes.get("/templates", (ctx) => {
  authGuard(ctx);
  return { templates: db.listQuotaTemplates() };
});

tokenRoutes.post("/templates/:id/apply/:vkeyId", (ctx) => {
  authGuard(ctx);
  const ok = db.applyQuotaTemplate(ctx.params.id, ctx.params.vkeyId);
  if (!ok) {
    ctx.set.status = 404;
    return err("Template or virtual key not found", 404);
  }
  return { ok: true };
});

// ── Pricing ──────────────────────────────────────────────────────────────────
tokenRoutes.get("/pricing", (ctx) => {
  authGuard(ctx);
  return { pricing: listAllPricing() };
});

tokenRoutes.post("/pricing/:model", (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as { input?: number; output?: number; cachedInput?: number };
  if (typeof body.input !== "number" || typeof body.output !== "number") {
    ctx.set.status = 400;
    return err("input and output (USD per 1M tokens) are required numbers", 400);
  }
  const pricing: ModelPricing = {
    input: body.input,
    output: body.output,
    cachedInput: body.cachedInput,
  };
  setPricingOverride(ctx.params.model, pricing);
  return { ok: true, model: ctx.params.model, pricing };
});

tokenRoutes.delete("/pricing/:model", (ctx) => {
  authGuard(ctx);
  clearPricingOverride(ctx.params.model);
  return { ok: true };
});
