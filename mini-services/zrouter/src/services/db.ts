/**
 * SQLite-backed request logging & observability.
 *
 * Stores every chat completion request in SQLite so the dashboard can show
 * token usage, costs, latency, and fallback audit trail.
 *
 * Schema (idempotent migrations via ensureColumns):
 *   request_logs (id, api_key_id, provider_id, model, prompt_tokens,
 *     completion_tokens, total_tokens, status_code, latency_ms,
 *     cached_tokens, reasoning_tokens, estimated_cost,
 *     fallback_occurred, fallback_path, fallback_reason, created_at)
 *
 *   api_keys (id, key, name, enabled, rate_limit, quota_limit,
 *     usage_tokens, credit_limit, usage_cost, allowed_models, created_at)
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { dataFile } from "./paths";

// Export getDb for use in routes when direct SQL is needed
export { getDb };

const DEFAULT_DB_PATH = dataFile("krouter.db");

let db: Database | null = null;

function dbPath(): string {
  return process.env.KROUTER_DB_PATH || DEFAULT_DB_PATH;
}

function getDb(): Database {
  if (db) return db;
  const p = dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p, { create: true });
  // Performance pragmas
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA cache_size = -20000;");
  initSchema(db);
  return db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      api_key_id TEXT,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      estimated_cost REAL DEFAULT 0,
      fallback_occurred INTEGER DEFAULT 0,
      fallback_path TEXT,
      fallback_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_provider ON request_logs(provider_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      rate_limit INTEGER NOT NULL DEFAULT 0,
      quota_limit INTEGER NOT NULL DEFAULT 0,
      usage_tokens INTEGER NOT NULL DEFAULT 0,
      credit_limit REAL NOT NULL DEFAULT 0,
      usage_cost REAL NOT NULL DEFAULT 0,
      allowed_models TEXT,
      deny_models TEXT DEFAULT '[]',
      roles TEXT DEFAULT '[\"read\"]',
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Unified upstream API-key pool. Each row is one (provider, apiKey, optional
    -- proxy URL) tuple. The registry picks one entry per request via round-robin
    -- (oldest last_used_at first). On 429/403/503/quota, the entry is put in
    -- cooldown for cooldown_until ms and the next entry is tried.
    CREATE TABLE IF NOT EXISTS key_pool (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT,
      proxy_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      weight INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',     -- active | cooldown | disabled
      cooldown_until INTEGER,
      last_used_at INTEGER,
      last_failed_at INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_key_pool_provider ON key_pool(provider_id, enabled, status);
    CREATE INDEX IF NOT EXISTS idx_key_pool_cooldown ON key_pool(cooldown_until);
  `);
}

// ── Request logs ─────────────────────────────────────────────────────────────

export interface RequestLog {
  id: string;
  apiKeyId?: string;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  statusCode: number;
  latencyMs: number;
  estimatedCost: number;
  fallbackOccurred: boolean;
  fallbackPath?: string;
  fallbackReason?: string;
}

export function logRequest(log: RequestLog): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO request_logs
        (id, api_key_id, provider_id, model, prompt_tokens, completion_tokens, total_tokens,
         status_code, latency_ms, estimated_cost, fallback_occurred, fallback_path, fallback_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.id,
      log.apiKeyId ?? null,
      log.providerId,
      log.model,
      log.promptTokens,
      log.completionTokens,
      log.totalTokens,
      log.statusCode,
      log.latencyMs,
      log.estimatedCost,
      log.fallbackOccurred ? 1 : 0,
      log.fallbackPath ?? null,
      log.fallbackReason ?? null,
      Date.now()
    );
  } catch (err) {
    console.error("[logRequest] failed:", err);
  }
}

// ── Usage summaries ────────────────────────────────────────────────────────

export interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  fallbackCount: number;
  avgLatencyMs: number;
  errorCount: number;
}

export function getUsageSummary(sinceMs = 0): UsageSummary {
  try {
    const db = getDb();
    const since = sinceMs > 0 ? `WHERE created_at >= ${Date.now() - sinceMs}` : "";
    const row = db
      .prepare(
        `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) as completion_tokens,
          COALESCE(SUM(estimated_cost), 0) as estimated_cost,
          COALESCE(SUM(fallback_occurred), 0) as fallback_count,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
          SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
         FROM request_logs ${since}`
      )
      .get() as Record<string, number>;
    return {
      totalRequests: row.total_requests ?? 0,
      totalTokens: row.total_tokens ?? 0,
      promptTokens: row.prompt_tokens ?? 0,
      completionTokens: row.completion_tokens ?? 0,
      estimatedCost: row.estimated_cost ?? 0,
      fallbackCount: row.fallback_count ?? 0,
      avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
      errorCount: row.error_count ?? 0,
    };
  } catch {
    return {
      totalRequests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCost: 0,
      fallbackCount: 0,
      avgLatencyMs: 0,
      errorCount: 0,
    };
  }
}

export interface ModelUsageRow {
  model: string;
  providerId: string;
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;
  lastUsedAt: number;
}

export function getUsageByModel(limit = 50): ModelUsageRow[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT
          model,
          provider_id as providerId,
          COUNT(*) as requests,
          COALESCE(SUM(total_tokens), 0) as totalTokens,
          COALESCE(SUM(prompt_tokens), 0) as promptTokens,
          COALESCE(SUM(completion_tokens), 0) as completionTokens,
          COALESCE(SUM(estimated_cost), 0) as estimatedCost,
          MAX(created_at) as lastUsedAt
         FROM request_logs
         GROUP BY model
         ORDER BY lastUsedAt DESC
         LIMIT ?`
      )
      .all(limit) as ModelUsageRow[];
  } catch {
    return [];
  }
}

export interface LogRow {
  id: string;
  apiKeyId: string | null;
  providerId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  statusCode: number;
  latencyMs: number;
  estimatedCost: number;
  fallbackOccurred: number;
  fallbackPath: string | null;
  fallbackReason: string | null;
  createdAt: number;
}

export function getRecentLogs(limit = 100): LogRow[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as LogRow[];
  } catch {
    return [];
  }
}

// ── API keys (virtual keys with rate limit + quota) ─────────────────────────

export interface VirtualKey {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  rateLimit: number; // req/min, 0 = unlimited
  quotaLimit: number; // lifetime tokens, 0 = unlimited
  usageTokens: number;
  creditLimit: number; // USD, 0 = unlimited
  usageCost: number;
  allowedModels: string[] | null;
  denyModels: string[];
  roles: ("read" | "write" | "admin")[];
  expiresAt?: number;
  createdAt: number;
}

export function listVirtualKeys(): VirtualKey[] {
  try {
    const db = getDb();
    return db
      .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id as string,
          key: row.key as string,
          name: row.name as string,
          enabled: Boolean(row.enabled),
          rateLimit: row.rate_limit as number,
          quotaLimit: row.quota_limit as number,
          usageTokens: row.usage_tokens as number,
          creditLimit: row.credit_limit as number,
          usageCost: row.usage_cost as number,
          allowedModels: row.allowed_models ? JSON.parse(row.allowed_models as string) : null,
          createdAt: row.created_at as number,
        };
      });
  } catch {
    return [];
  }
}

export function createVirtualKey(name: string, opts?: Partial<VirtualKey>): VirtualKey {
  const db = getDb();
  const id = crypto.randomUUID();
  const key = `kr-${crypto.randomBytes(20).toString("hex")}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO api_keys
      (id, key, name, enabled, rate_limit, quota_limit, usage_tokens, credit_limit, usage_cost, allowed_models, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`
  ).run(
    id,
    key,
    name,
    opts?.enabled === false ? 0 : 1,
    opts?.rateLimit ?? 0,
    opts?.quotaLimit ?? 0,
    opts?.creditLimit ?? 0,
    opts?.allowedModels ? JSON.stringify(opts.allowedModels) : null,
    now
  );
  return {
    id,
    key,
    name,
    enabled: opts?.enabled !== false,
    rateLimit: opts?.rateLimit ?? 0,
    quotaLimit: opts?.quotaLimit ?? 0,
    usageTokens: 0,
    creditLimit: opts?.creditLimit ?? 0,
    usageCost: 0,
    allowedModels: opts?.allowedModels ?? null,
    createdAt: now,
  };
}

export function findVirtualKey(token: string): VirtualKey | undefined {
  try {
    const db = getDb();
    const cleaned = token.startsWith("Bearer ") ? token.slice(7) : token;
    const row = db.prepare("SELECT * FROM api_keys WHERE key = ? AND enabled = 1").get(cleaned) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      key: row.key as string,
      name: row.name as string,
      enabled: Boolean(row.enabled),
      rateLimit: row.rate_limit as number,
      quotaLimit: row.quota_limit as number,
      usageTokens: row.usage_tokens as number,
      creditLimit: row.credit_limit as number,
      usageCost: row.usage_cost as number,
      allowedModels: row.allowed_models ? JSON.parse(row.allowed_models as string) : null,
      createdAt: row.created_at as number,
    };
  } catch {
    return undefined;
  }
}

export function deleteVirtualKey(id: string): void {
  getDb().prepare("DELETE FROM api_keys WHERE id = ?").run(id);
}

export function incrementVirtualKeyUsage(id: string, tokens: number, cost = 0): void {
  try {
    getDb()
      .prepare("UPDATE api_keys SET usage_tokens = usage_tokens + ?, usage_cost = usage_cost + ? WHERE id = ?")
      .run(tokens, cost, id);
  } catch (err) {
    console.error("[incrementVirtualKeyUsage] failed:", err);
  }
}

// ── Settings (key-value store) ─────────────────────────────────────────────

export function getSetting(key: string, defaultValue = ""): string {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

// ── Token Analytics ──────────────────────────────────────────────────────────

export interface CostTrendRow {
  date: string; // YYYY-MM-DD
  cost: number;
  tokens: number;
  requests: number;
}

/** Daily cost + token rollup for the last N days. */
export function getCostTrend(days = 30): CostTrendRow[] {
  try {
    const db = getDb();
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return db.prepare(
      `SELECT
        date(created_at / 1000, 'unixepoch') as date,
        COALESCE(SUM(estimated_cost), 0) as cost,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COUNT(*) as requests
       FROM request_logs
       WHERE created_at >= ?
       GROUP BY date
       ORDER BY date ASC`
    ).all(since) as CostTrendRow[];
  } catch {
    return [];
  }
}

export interface TopConsumerRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  cost: number;
  tokens: number;
  requests: number;
}

/** Top N API keys by total cost. */
export function getTopConsumers(limit = 10): TopConsumerRow[] {
  try {
    const db = getDb();
    return db.prepare(
      `SELECT
        r.api_key_id as apiKeyId,
        k.name as apiKeyName,
        COALESCE(SUM(r.estimated_cost), 0) as cost,
        COALESCE(SUM(r.total_tokens), 0) as tokens,
        COUNT(*) as requests
       FROM request_logs r
       LEFT JOIN api_keys k ON r.api_key_id = k.id
       GROUP BY r.api_key_id
       ORDER BY cost DESC
       LIMIT ?`
    ).all(limit) as TopConsumerRow[];
  } catch {
    return [];
  }
}

export interface CostByModelRow {
  model: string;
  cost: number;
  tokens: number;
  requests: number;
}

/** Cost breakdown by model. */
export function getCostByModel(limit = 20): CostByModelRow[] {
  try {
    const db = getDb();
    return db.prepare(
      `SELECT
        model,
        COALESCE(SUM(estimated_cost), 0) as cost,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COUNT(*) as requests
       FROM request_logs
       GROUP BY model
       ORDER BY cost DESC
       LIMIT ?`
    ).all(limit) as CostByModelRow[];
  } catch {
    return [];
  }
}

export interface CostSummary {
  totalCost: number;
  totalTokens: number;
  totalRequests: number;
  avgCostPerRequest: number;
  avgCostPer1kTokens: number;
  todayCost: number;
  weekCost: number;
  monthCost: number;
}

/** Comprehensive cost summary for the dashboard. */
export function getCostSummary(): CostSummary {
  try {
    const db = getDb();
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    const weekMs = now - 7 * 24 * 60 * 60 * 1000;
    const monthMs = now - 30 * 24 * 60 * 60 * 1000;

    const total = db.prepare(
      `SELECT
        COALESCE(SUM(estimated_cost), 0) as cost,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COUNT(*) as requests
       FROM request_logs`
    ).get() as { cost: number; tokens: number; requests: number };

    const today = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost), 0) as cost FROM request_logs WHERE created_at >= ?`
    ).get(todayMs) as { cost: number };

    const week = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost), 0) as cost FROM request_logs WHERE created_at >= ?`
    ).get(weekMs) as { cost: number };

    const month = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost), 0) as cost FROM request_logs WHERE created_at >= ?`
    ).get(monthMs) as { cost: number };

    const totalCost = total.cost ?? 0;
    const totalTokens = total.tokens ?? 0;
    const totalRequests = total.requests ?? 0;

    return {
      totalCost,
      totalTokens,
      totalRequests,
      avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
      avgCostPer1kTokens: totalTokens > 0 ? (totalCost / totalTokens) * 1000 : 0,
      todayCost: today.cost ?? 0,
      weekCost: week.cost ?? 0,
      monthCost: month.cost ?? 0,
    };
  } catch {
    return {
      totalCost: 0,
      totalTokens: 0,
      totalRequests: 0,
      avgCostPerRequest: 0,
      avgCostPer1kTokens: 0,
      todayCost: 0,
      weekCost: 0,
      monthCost: 0,
    };
  }
}

export interface ForecastRow {
  date: string;
  predictedCost: number;
  predictedTokens: number;
}

/**
 * 7-day forecast based on the last 14 days of actual usage.
 * Uses simple linear regression on daily totals.
 */
export function getUsageForecast(days = 7): ForecastRow[] {
  try {
    const trend = getCostTrend(14);
    if (trend.length < 2) return [];
    // Linear regression on cost & tokens
    const n = trend.length;
    const xs = trend.map((_, i) => i);
    const ysCost = trend.map((t) => t.cost);
    const ysTokens = trend.map((t) => t.tokens);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanYCost = ysCost.reduce((a, b) => a + b, 0) / n;
    const meanYTokens = ysTokens.reduce((a, b) => a + b, 0) / n;
    let numCost = 0, numTokens = 0, den = 0;
    for (let i = 0; i < n; i++) {
      numCost += (xs[i]! - meanX) * (ysCost[i]! - meanYCost);
      numTokens += (xs[i]! - meanX) * (ysTokens[i]! - meanYTokens);
      den += (xs[i]! - meanX) ** 2;
    }
    const slopeCost = den === 0 ? 0 : numCost / den;
    const slopeTokens = den === 0 ? 0 : numTokens / den;
    const interceptCost = meanYCost - slopeCost * meanX;
    const interceptTokens = meanYTokens - slopeTokens * meanX;

    const result: ForecastRow[] = [];
    for (let d = 1; d <= days; d++) {
      const x = n - 1 + d;
      const date = new Date();
      date.setDate(date.getDate() + d);
      result.push({
        date: date.toISOString().slice(0, 10),
        predictedCost: Math.max(0, slopeCost * x + interceptCost),
        predictedTokens: Math.max(0, slopeTokens * x + interceptTokens),
      });
    }
    return result;
  } catch {
    return [];
  }
}

export interface BudgetAlert {
  apiKeyId: string;
  apiKeyName: string;
  type: "quota" | "credit";
  limit: number;
  used: number;
  percent: number;
  severity: "warning" | "critical";
}

/**
 * Check all virtual keys for budget threshold breaches.
 * Warning at 80%, critical at 95%.
 */
export function getBudgetAlerts(): BudgetAlert[] {
  try {
    const keys = listVirtualKeys();
    const alerts: BudgetAlert[] = [];
    for (const k of keys) {
      if (k.quotaLimit && k.quotaLimit > 0) {
        const percent = (k.usageTokens / k.quotaLimit) * 100;
        if (percent >= 80) {
          alerts.push({
            apiKeyId: k.id,
            apiKeyName: k.name,
            type: "quota",
            limit: k.quotaLimit,
            used: k.usageTokens,
            percent,
            severity: percent >= 95 ? "critical" : "warning",
          });
        }
      }
      if (k.creditLimit && k.creditLimit > 0) {
        const percent = (k.usageCost / k.creditLimit) * 100;
        if (percent >= 80) {
          alerts.push({
            apiKeyId: k.id,
            apiKeyName: k.name,
            type: "credit",
            limit: k.creditLimit,
            used: k.usageCost,
            percent,
            severity: percent >= 95 ? "critical" : "warning",
          });
        }
      }
    }
    return alerts.sort((a, b) => b.percent - a.percent);
  } catch {
    return [];
  }
}

// ── Quota Templates ──────────────────────────────────────────────────────────

export interface QuotaTemplate {
  id: string;
  name: string;
  description?: string;
  rateLimit: number;
  quotaLimit: number;
  creditLimit: number;
}

const DEFAULT_TEMPLATES: QuotaTemplate[] = [
  {
    id: "free-tier",
    name: "Free Tier",
    description: "10 req/min, 100K tokens, $1 credit — for evaluation",
    rateLimit: 10,
    quotaLimit: 100_000,
    creditLimit: 1,
  },
  {
    id: "pro-tier",
    name: "Pro Tier",
    description: "60 req/min, 5M tokens, $50 credit — for production apps",
    rateLimit: 60,
    quotaLimit: 5_000_000,
    creditLimit: 50,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    description: "600 req/min, 100M tokens, $1000 credit — for high-volume",
    rateLimit: 600,
    quotaLimit: 100_000_000,
    creditLimit: 1000,
  },
  {
    id: "internal",
    name: "Internal (unlimited)",
    description: "No rate limit, no quota, no credit cap — for trusted internal use",
    rateLimit: 0,
    quotaLimit: 0,
    creditLimit: 0,
  },
];

export function listQuotaTemplates(): QuotaTemplate[] {
  try {
    const raw = getSetting("quota_templates", JSON.stringify(DEFAULT_TEMPLATES));
    const parsed = JSON.parse(raw) as QuotaTemplate[];
    return parsed.length > 0 ? parsed : DEFAULT_TEMPLATES;
  } catch {
    return DEFAULT_TEMPLATES;
  }
}

export function getQuotaTemplate(id: string): QuotaTemplate | undefined {
  return listQuotaTemplates().find((t) => t.id === id);
}

export function saveQuotaTemplates(templates: QuotaTemplate[]): void {
  setSetting("quota_templates", JSON.stringify(templates));
}

/** Apply a quota template to a virtual key. */
export function applyQuotaTemplate(templateId: string, vkeyId: string): boolean {
  const template = getQuotaTemplate(templateId);
  if (!template) return false;
  const db = getDb();
  const result = db.prepare(
    "UPDATE api_keys SET rate_limit = ?, quota_limit = ?, credit_limit = ? WHERE id = ?"
  ).run(template.rateLimit, template.quotaLimit, template.creditLimit, vkeyId);
  return (result.changes ?? 0) > 0;
}
