/**
 * KRouter MCP server (this process is the server, not a client).
 *
 * Streamable HTTP at POST/GET/DELETE /mcp, protocol 2025-03-26.
 * Clients such as ZCode and OpenClaw connect here and call the tools below.
 * SSH, shell, and arbitrary network tools are intentionally not exposed.
 */

import * as db from "./db";
import * as store from "./config-store";
import * as registry from "./registry";
import * as templates from "./prompt-templates";
import { getCacheStats, clearCache } from "./cache";
import { getProxySettings, proxyStats, proxyUrl } from "./proxy-settings";
import { listProxies as listPool } from "./proxy-manager";
import { refreshPool, getAutoRefreshSettings, getLastRun } from "./proxy-refresher";
import { getPublicAccessSettings } from "./public-access";
import { fetchWithRetry } from "../utils/retry";
import { pickProxy } from "./proxy-settings";

export const MCP_PROTOCOL = "2025-03-26";

const sessions = new Map<string, { createdAt: number }>();

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const TOOLS: ToolDef[] = [
  {
    name: "krouter_status",
    description: "Gateway status: admin keys, enabled providers, and virtual keys.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({
      ok: true,
      adminKeyCount: store.listAdminKeys().length,
      providerCount: store.listProviders().filter((p) => p.enabled).length,
      virtualKeyCount: db.listVirtualKeys().length,
      customProviderCount: store.listCustomProviders().length,
    }),
  },
  {
    name: "krouter_list_models",
    description: "List models currently exposed by enabled providers. Ids are provider/model.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const models = await registry.listAllModels();
      return {
        count: models.length,
        models: models.map((m) => ({ id: m.id, ownedBy: m.owned_by })),
      };
    },
  },
  {
    name: "krouter_usage",
    description: "Token, cost, latency, and error totals from the request log.",
    inputSchema: {
      type: "object",
      properties: {
        sinceHours: { type: "number", description: "Only count requests newer than this many hours. 0 means all time." },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const hours = Number(args.sinceHours ?? 0);
      const sinceMs = Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 0;
      return db.getUsageSummary(sinceMs);
    },
  },
  {
    name: "krouter_recent_logs",
    description: "Recent gateway requests: model, tokens, status, latency, and cost. No prompts or secrets.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many rows, 1-100. Default 20." },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      const limit = Math.min(100, Math.max(1, Math.floor(num(args.limit, 20))));
      return db.getRecentLogs(limit).map((row) => ({
        id: row.id,
        providerId: row.providerId,
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        statusCode: row.statusCode,
        latencyMs: row.latencyMs,
        estimatedCost: row.estimatedCost,
        createdAt: row.createdAt,
      }));
    },
  },
  {
    name: "krouter_list_providers",
    description: "List built-in and custom providers. API keys are never returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const customIds = new Set(store.listCustomProviders().map((p) => p.id));
      return store.listProviders().map((p) => ({
        id: p.id,
        enabled: p.enabled,
        baseUrl: p.baseUrl ?? null,
        hasApiKey: Boolean(p.apiKey),
        custom: customIds.has(p.id),
      }));
    },
  },
  {
    name: "krouter_list_prompts",
    description: "List saved prompt templates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => templates.listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      description: t.description ?? "",
      suggestedModel: t.suggestedModel ?? "",
    })),
  },
  {
    name: "krouter_render_prompt",
    description: "Fill {{variables}} in a saved prompt template and return the text.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Template id from krouter_list_prompts." },
        vars: { type: "object", description: "Values for {{placeholders}}.", additionalProperties: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (args) => {
      const template = templates.getTemplate(str(args.id));
      if (!template) return { error: "Template not found" };
      const vars = (args.vars && typeof args.vars === "object" ? args.vars : {}) as Record<string, unknown>;
      const stringVars: Record<string, string> = {};
      for (const [key, value] of Object.entries(vars)) stringVars[key] = String(value);
      return { content: templates.renderTemplate(template, stringVars) };
    },
  },
  {
    name: "krouter_chat",
    description: "Send one chat completion through the gateway to any enabled model (e.g. opencode/big-pickle). Proxy fallback and retries apply automatically.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id, provider/model form. Example: opencode/big-pickle" },
        message: { type: "string", description: "Single user message. Use this OR messages." },
        messages: {
          type: "array",
          description: "Full OpenAI-style message array (role + content). Use this OR message.",
          items: {
            type: "object",
            properties: { role: { type: "string" }, content: { type: "string" } },
            required: ["role", "content"],
          },
        },
        maxTokens: { type: "number", description: "Completion budget. Default 256." },
      },
      required: ["model"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const model = str(args.model);
      const maxTokens = Math.min(4096, Math.max(1, Math.floor(num(args.maxTokens, 256))));
      const messages = Array.isArray(args.messages) && args.messages.length > 0
        ? (args.messages as Array<{ role?: unknown; content?: unknown }>).map((m) => ({
            role: String(m.role ?? "user"),
            content: String(m.content ?? ""),
          }))
        : [{ role: "user", content: str(args.message) }];
      if (messages.length === 0) return { error: "Provide message or messages" };
      try {
        const response = await registry.chatCompletion({
          model,
          messages,
          max_tokens: maxTokens,
        } as Parameters<typeof registry.chatCompletion>[0]);
        return {
          model,
          content: response.choices?.[0]?.message?.content ?? "",
          finishReason: response.choices?.[0]?.finish_reason ?? null,
          usage: response.usage ?? null,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: "krouter_proxy_pool",
    description: "Proxy routing mode, pool health stats, and the newest pool entries. Never returns proxy credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const pool = listPool().slice(0, 15).map((p) => ({
        host: p.host,
        port: p.port,
        protocol: p.protocol,
        active: p.isActive,
        latencyMs: p.responseTimeMs,
        uptimeScore: Math.round(p.uptimeScore * 100) / 100,
      }));
      return { settings: getProxySettings(), stats: proxyStats(), pool };
    },
  },
  {
    name: "krouter_refresh_proxies",
    description: "Run the proxy pool refresh pipeline now: scrape public proxies, health-check the pool against the provider, remove the dead ones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const result = await refreshPool();
      return { ...result, stats: proxyStats() };
    },
  },
  {
    name: "krouter_model_health",
    description: "Live probe of the OpenCode free models (big-pickle and friends) through the current proxy setup.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const freeModels = [
        "opencode/big-pickle",
        "opencode/deepseek-v4-flash-free",
        "opencode/mimo-v2.5-free",
        "opencode/nemotron-3-ultra-free",
      ];
      const results = await Promise.all(freeModels.map(async (model) => {
        const started = Date.now();
        const target = model.replace(/^opencode\//, "");
        const proxy = pickProxy();
        try {
          const res = await fetchWithRetry(
            "https://opencode.ai/zen/v1/chat/completions",
            { model: target, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 8, stream: false },
            { Authorization: "Bearer public", "User-Agent": "opencode" },
            1
          );
          const body = await res.text().catch(() => "");
          let detail = res.ok ? "responding" : body.slice(0, 140);
          if (!res.ok) {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const inner = parsed.error as { type?: string; message?: string; error?: { message?: string } } | undefined;
              detail = inner?.type ?? inner?.error?.message ?? inner?.message ?? detail;
            } catch { /* keep raw slice */ }
          }
          return { model, ok: res.ok, status: res.status, latencyMs: Date.now() - started, detail, viaProxy: Boolean(proxy) };
        } catch (err) {
          return { model, ok: false, status: 0, latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err), viaProxy: Boolean(proxy) };
        }
      }));
      return { healthy: results.filter((r) => r.ok).length, total: results.length, models: results };
    },
  },
  {
    name: "krouter_cache",
    description: "Response cache statistics. Optional action 'clear' wipes the cache.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'stats' (default) or 'clear'." },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      if (str(args.action).toLowerCase() === "clear") {
        clearCache();
        return { cleared: true, stats: getCacheStats() };
      }
      return { stats: getCacheStats() };
    },
  },
  {
    name: "krouter_list_virtual_keys",
    description: "List virtual keys with scopes and usage. Key secrets are never returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => db.listVirtualKeys().map((k) => ({
      id: k.id,
      name: k.name,
      enabled: k.enabled,
      roles: k.roles,
      allowedModels: k.allowedModels,
      denyModels: k.denyModels,
      rateLimit: k.rateLimit,
      quotaLimit: k.quotaLimit,
      usageTokens: k.usageTokens,
      usageCost: k.usageCost,
      expiresAt: k.expiresAt ?? null,
    })),
  },
  {
    name: "krouter_system",
    description: "Runtime info: versions, uptime, memory, feature toggles (public access, proxy mode, auto refresh).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ({
      version: "2.1.0",
      runtime: `bun ${typeof Bun !== "undefined" ? Bun.version : "unknown"}`,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      publicFreeAccess: getPublicAccessSettings(),
      autoProxy: { ...getProxySettings(), stats: proxyStats() },
      autoRefresh: { settings: getAutoRefreshSettings(), lastRun: getLastRun() },
    }),
  },
  {
    name: "krouter_fetch",
    description:
      "Fetch an http(s) URL through a proxy from the KRouter proxy pool (falls back to direct with a warning when no proxy is active). Returns status and truncated body — text is returned as text, binary as base64.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
        method: { type: "string", description: "GET (default) or HEAD." },
        timeoutMs: { type: "number", description: "Timeout in ms, 1000-30000. Default 10000." },
        maxBytes: { type: "number", description: "Response size cap in bytes, up to 1000000. Default 200000." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawUrl = str(args.url);
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return { error: "Invalid URL" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { error: "Only http:// and https:// URLs are allowed" };
      }
      const method = str(args.method).toUpperCase() || "GET";
      if (method !== "GET" && method !== "HEAD") return { error: "Only GET or HEAD are allowed" };
      const timeoutMs = Math.min(30000, Math.max(1000, Math.floor(num(args.timeoutMs, 10000))));
      const maxBytes = Math.min(1000000, Math.max(1024, Math.floor(num(args.maxBytes, 200000))));

      // Force a pool proxy (this tool exists specifically to browse via the pool)
      const active = listPool({ active: true });
      const chosen = active.length > 0 ? active[Math.floor(Math.random() * active.length)] : undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(parsed.href, {
          method,
          signal: controller.signal,
          redirect: "follow",
          ...(chosen ? { proxy: proxyUrl(chosen) } : {}),
        } as RequestInit & { proxy?: string });

        let bytes = 0;
        const chunks: Uint8Array[] = [];
        let truncated = false;
        if (method === "GET" && res.body) {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              bytes += value.length;
              if (bytes >= maxBytes) {
                truncated = true;
                await reader.cancel().catch(() => undefined);
                break;
              }
            }
          }
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const c of chunks) {
          body.set(c, offset);
          offset += c.length;
        }

        const contentType = res.headers.get("content-type") ?? "";
        const textLike = /text\.|json|xml|javascript|x-www-form-urlencoded/i.test(contentType);
        const out: Record<string, unknown> = {
          url: parsed.href,
          status: res.status,
          ok: res.ok,
          viaProxy: Boolean(chosen),
          proxy: chosen ? `${chosen.host}:${chosen.port}` : null,
          warning: chosen ? undefined : "No active proxy in pool — fetched directly",
          contentType: contentType || null,
          bytes,
          truncated,
        };
        if (method === "GET") {
          if (textLike || bytes === 0) {
            out.text = new TextDecoder("utf-8", { fatal: false }).decode(body);
          } else {
            out.bodyEncoding = "base64";
            out.bodyBase64 = Buffer.from(body).toString("base64");
          }
        }
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          error: /abort/i.test(msg) ? `Timed out after ${timeoutMs}ms` : msg,
          viaProxy: Boolean(chosen),
          proxy: chosen ? `${chosen.host}:${chosen.port}` : null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    name: "calculator",
    description: "Evaluate one arithmetic expression. Supports + - * / % parentheses and sqrt, abs, round, floor, ceil, min, max, pow.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Example: (12 + 8) * 1.5" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
    handler: (args) => evaluateMath(str(args.expression)),
  },
];

function evaluateMath(expression: string): { expression: string; result: number } | { error: string } {
  const source = expression.trim();
  if (!source || source.length > 200) return { error: "Expression is empty or too long" };
  if (!/^[\d\s+\-*/%().,a-z]+$/i.test(source)) return { error: "Expression contains unsupported characters" };
  const allowed = new Set(["sqrt", "abs", "round", "floor", "ceil", "min", "max", "pow"]);
  const names = source.match(/[a-z]+/gi) ?? [];
  if (names.some((name) => !allowed.has(name.toLowerCase()))) {
    return { error: "Only sqrt, abs, round, floor, ceil, min, max, and pow are allowed" };
  }
  const fn = new Function(
    "sqrt", "abs", "round", "floor", "ceil", "min", "max", "pow",
    `"use strict"; return (${source});`
  );
  const value = fn(Math.sqrt, Math.abs, Math.round, Math.floor, Math.ceil, Math.min, Math.max, Math.pow);
  if (typeof value !== "number" || !Number.isFinite(value)) return { error: "Expression did not produce a finite number" };
  return { expression: source, result: value };
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(message: RpcRequest): Promise<unknown | null> {
  const id = message.id ?? null;
  const method = message.method ?? "";
  const params = message.params ?? {};
  const isNotification = message.id === undefined;

  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "krouter", version: "2.1.0" },
      instructions: "KRouter is the MCP server. Use these tools to inspect the gateway. Chat still goes to POST /v1/chat/completions.",
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = str(params.name);
    const args = (params.arguments && typeof params.arguments === "object"
      ? params.arguments
      : {}) as Record<string, unknown>;
    const tool = TOOLS.find((item) => item.name === name);
    if (!tool) return rpcResult(id, textResult(`Unknown tool: ${name}`, true));
    try {
      return rpcResult(id, textResult(await tool.handler(args)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rpcResult(id, textResult(message, true));
    }
  }

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  const alt = request.headers.get("x-api-key") ?? "";
  const candidate = token || alt;
  if (!candidate) return store.listAdminKeys().length === 0;
  return Boolean(store.findAdminKey(candidate) || db.findVirtualKey(candidate));
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
      ...extra,
    },
  });
}

export function mcpInfo() {
  return {
    endpoint: "/mcp",
    protocol: MCP_PROTOCOL,
    transport: "streamable-http",
    role: "server",
    auth: "Authorization: Bearer <admin or virtual key>",
    tools: TOOLS.map((tool) => tool.name),
  };
}

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version",
        "Access-Control-Expose-Headers": "Mcp-Session-Id",
      },
    });
  }

  if (!authorized(request)) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401);
  }

  if (request.method === "DELETE") {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) sessions.delete(sessionId);
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET") {
    const sessionId = request.headers.get("mcp-session-id") ?? "";
    if (!sessions.has(sessionId)) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown MCP session" } }, 404);
    }
    return json({ ok: true, sessionId, ...mcpInfo() }, 200, { "Mcp-Session-Id": sessionId });
  }

  if (request.method !== "POST") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Method not allowed" } }, 405);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses: unknown[] = [];
  let newSession: string | undefined;

  for (const item of messages) {
    if (!item || typeof item !== "object") {
      responses.push(rpcError(null, -32600, "Invalid request"));
      continue;
    }
    const message = item as RpcRequest;
    if (message.method === "initialize" && message.id !== undefined) {
      newSession = crypto.randomUUID();
      sessions.set(newSession, { createdAt: Date.now() });
    }
    const response = await handleRpc(message);
    if (response !== null) responses.push(response);
  }

  const headers: Record<string, string> = {};
  const existing = request.headers.get("mcp-session-id");
  if (newSession) headers["Mcp-Session-Id"] = newSession;
  else if (existing) headers["Mcp-Session-Id"] = existing;

  if (responses.length === 0) return new Response(null, { status: 202, headers });
  return json(Array.isArray(payload) ? responses : responses[0], 200, headers);
}
