/**
 * opencode-client.ts — direct, self-contained client for opencode.ai's free
 * tier. NO zrouter dependency.
 *
 * - Calls https://opencode.ai/zen/v1/chat/completions (OpenAI-compatible).
 * - Uses `Authorization: Bearer public` for free-tier access.
 * - Wraps every request with the OpenCode persona (system prompt + tool set)
 *   so the upstream free-tier gate accepts the request. The caller's real
 *   system prompt + tools are folded into the first user message.
 * - Translates persona tool-call names + args back to the caller's schema on
 *   the way out.
 * - Streaming SSE support out of the box.
 *
 * Identity headers (x-opencode-session/request/project) mirror the real
 * desktop client, as in 9Router's executor.
 */

import crypto from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ToolCall,
} from "./persona";
import { wrapWithPersona, translateResponse, translateStream } from "./persona";
import { parseDataLine, streamLines } from "./stream";

const BASE_URL = "https://opencode.ai";
const PUBLIC_BEARER = "Bearer public";
const FREE_TIER_KEY = "public"; // the documented free-tier Bearer token value

/** Detect free-tier mode: no key at all, OR the documented "public" Bearer. */
function isFreeTier(apiKey: string): boolean {
  return !apiKey || apiKey.trim().toLowerCase() === FREE_TIER_KEY;
}

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

function isResponsesModel(model: string): boolean {
  const base = model.replace(/\([^()]+\)\s*$/, "").trim();
  return RESPONSES_MODELS.has(base) || base.startsWith("muse-spark");
}

// Real-client ID format: 12 hex timestamp bytes (from Date.now()*0x1000+ctr,
// complemented for descending) + 14 base62 random chars.
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function schemaId(descending: boolean): string {
  const current = BigInt(Date.now()) * 0x1000n + 1n;
  const value = descending ? ~current : current;
  let time = "";
  for (let i = 0; i < 6; i++) time += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return time + Array.from(bytes, (b) => ID_CHARS[b % 62]).join("");
}

function generateSessionId(): string {
  return `ses_${schemaId(true)}`;
}

function generateRequestId(): string {
  return `msg_${schemaId(false)}`;
}

function generateProjectId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Singleton-ish session/project identity — persists for the life of the
 *  Next.js server process. */
const SESSION_ID = generateSessionId();
const PROJECT_ID = generateProjectId();

interface ResponsesInputPart {
  type: "input_text" | "output_text" | "input_image";
  text?: string;
  image_url?: string;
}

/** Convert OpenAI chat messages into Responses-API input items. */
function toResponsesInput(req: ChatCompletionRequest): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: String(m.content ?? "") }] satisfies ResponsesInputPart[],
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown }).tool_calls)) {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: typeof m.content === "string" ? m.content : "" }] satisfies ResponsesInputPart[],
      });
      continue;
    }
    const parts: ResponsesInputPart[] = [{ type: "input_text", text: typeof m.content === "string" ? m.content : "" }];
    input.push({ type: "message", role: m.role, content: parts });
  }
  return input;
}

/** Build a Responses-API request body from an OpenAI chat request. */
function toResponsesBody(req: ChatCompletionRequest, targetModel: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: targetModel,
    input: toResponsesInput(req),
    stream: true,
    store: false,
  };
  const maxTokens = req.max_tokens ?? (req as { max_completion_tokens?: number }).max_completion_tokens;
  if (maxTokens) body.max_output_tokens = maxTokens;
  const effort = (req as { reasoning_effort?: string }).reasoning_effort;
  if (effort) body.reasoning = { effort, summary: "auto" };
  return body;
}

/** Translate one Responses-API SSE event into zero or more OpenAI chunks. */
function responsesEventToChunks(
  event: Record<string, unknown>,
  req: ChatCompletionRequest
): ChatCompletionChunk[] {
  const type = event.type as string | undefined;
  if (type === "response.output_text.delta") {
    const delta = event.delta as string | undefined;
    if (!delta) return [];
    return [{
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
    } as ChatCompletionChunk];
  }
  if (type === "response.completed" || type === "response.incomplete") {
    const response = event.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
    const usage = response?.usage;
    return [{
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: usage
        ? {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          }
        : undefined,
    } as ChatCompletionChunk];
  }
  if (type === "error" || type === "response.failed") {
    const response = event.response as { error?: { message?: string } } | undefined;
    const err = (event.error ?? response?.error) as { message?: string } | undefined;
    throw new Error(`OpenCode responses error: ${err?.message ?? JSON.stringify(event).slice(0, 300)}`);
  }
  return [];
}

function buildUrl(targetModel: string, baseUrl: string): string {
  return isResponsesModel(targetModel)
    ? `${baseUrl}/zen/v1/responses`
    : `${baseUrl}/zen/v1/chat/completions`;
}

function getHeaders(stream: boolean, apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: apiKey ? `Bearer ${apiKey}` : PUBLIC_BEARER,
    "User-Agent": "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
    "x-opencode-client": "cli",
    "x-opencode-session": SESSION_ID,
    "x-opencode-request": generateRequestId(),
    "x-opencode-project": PROJECT_ID,
    Accept: stream ? "text/event-stream" : "*/*",
  };
}

// ── Simple fetchWithRetry (no proxy pool — direct upstream only) ──────────────
const MAX_RETRY_AFTER_MS = 8_000;
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

interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

async function fetchWithRetry(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  maxRetries = 3,
  signal?: AbortSignal
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const opts: FetchOpts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Encoding": "identity", ...headers },
      signal,
    };
    if (body !== undefined && body !== null) {
      opts.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    try {
      const res = await fetch(url, opts as RequestInit);
      if (res.ok || !TRANSIENT_STATUSES.has(res.status)) return res;
      const retryAfter = parseRetryHeaders(res.headers);
      const delay = retryAfter !== null ? Math.min(retryAfter, MAX_RETRY_AFTER_MS) : backoffMs(attempt);
      if (attempt === maxRetries) return res;
      await res.text().catch(() => undefined);
      if (signal?.aborted) return res;
      await sleep(delay);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted) throw lastError;
      const msg = lastError.message;
      const isTransient = TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg));
      if (!isTransient || attempt === maxRetries) throw lastError;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError ?? new Error("fetchWithRetry: exhausted retries");
}

function backoffMs(attempt: number): number {
  return Math.min(400 * Math.pow(2, attempt), 2000);
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

// ── Public API ────────────────────────────────────────────────────────────────

export type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ToolCall } from "./persona";

export interface OpencodeConfig {
  baseUrl?: string;
  apiKey?: string;
}

/** Build an opencode.ai request URL for a given model. */
export function opencodeUrl(model: string, cfg: OpencodeConfig = {}): string {
  const base = (cfg.baseUrl ?? BASE_URL).replace(/\/$/, "");
  const target = model.replace(/^opencode\//, "");
  return buildUrl(target, base);
}

/** Get the configured API key (env-overridable, defaults to free "public"). */
export function getOpencodeApiKey(): string {
  const k = process.env.OPENCODE_API_KEY ?? process.env.KROUTER_KEY ?? "";
  return isFreeTier(k) ? "" : k;
}

/**
 * Streaming chat completion. Returns an async generator of OpenAI-format
 * chunks. Tool-call deltas are buffered + translated by translateStream.
 */
export async function* chatStream(
  req: ChatCompletionRequest,
  cfg: OpencodeConfig = {},
  signal?: AbortSignal
): AsyncGenerator<ChatCompletionChunk, void, void> {
  const targetModel = req.model.replace(/^opencode\//, "");
  const url = opencodeUrl(req.model, cfg);
  const apiKey = cfg.apiKey ?? getOpencodeApiKey();

  // muse-spark models go through the Responses API.
  if (isResponsesModel(targetModel)) {
    const body = toResponsesBody({ ...req, model: targetModel }, targetModel);
    const res = await fetchWithRetry(url, body, getHeaders(true, apiKey), 3, signal);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode stream error (${res.status}): ${text.slice(0, 300)}`);
    }
    for await (const line of streamLines(res.body)) {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) continue;
      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>;
        for (const chunk of responsesEventToChunks(event, req)) yield chunk;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("OpenCode responses error")) throw err;
      }
    }
    return;
  }

  // Standard chat-completions stream — wrap with persona if free-tier.
  const body: ChatCompletionRequest = { ...req, model: targetModel, stream: true };
  const persona = isFreeTier(apiKey)
    ? wrapWithPersona(body)
    : null;
  const res = await fetchWithRetry(
    url,
    (persona?.body ?? body) as unknown as Record<string, unknown>,
    getHeaders(true, apiKey),
    3,
    signal
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenCode stream error (${res.status}): ${text.slice(0, 300)}`);
  }
  const raw = (async function* () {
    for await (const line of streamLines(res.body!)) {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) continue;
      try {
        const parsed = JSON.parse(jsonStr) as ChatCompletionChunk;
        parsed.model = req.model;
        yield parsed;
      } catch {
        /* ignore malformed chunk */
      }
    }
  })();
  if (persona) {
    yield* translateStream(raw, persona.map);
    return;
  }
  yield* raw;
}

/**
 * Non-streaming chat completion — accumulates the stream internally and
 * returns one ChatCompletionResponse. Used for quick model-list / health
 * probes; the agentic loop uses chatStream() for live UI feedback.
 */
export async function chatComplete(
  req: ChatCompletionRequest,
  cfg: OpencodeConfig = {},
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const targetModel = req.model.replace(/^opencode\//, "");
  const url = opencodeUrl(req.model, cfg);
  const apiKey = cfg.apiKey ?? getOpencodeApiKey();

  if (isResponsesModel(targetModel)) {
    let text = "";
    let usage: ChatCompletionResponse["usage"];
    for await (const chunk of chatStream({ ...req, model: targetModel }, cfg, signal)) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) text += delta;
      if (chunk.usage) usage = chunk.usage;
    }
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as ChatCompletionResponse;
  }

  const body: ChatCompletionRequest = { ...req, model: targetModel, stream: true };
  const persona = isFreeTier(apiKey) ? wrapWithPersona(body) : null;
  const res = await fetchWithRetry(
    url,
    (persona?.body ?? body) as unknown as Record<string, unknown>,
    getHeaders(true, apiKey),
    3,
    signal
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenCode error (${res.status}): ${text.slice(0, 300)}`);
  }
  let content = "";
  let reasoning = "";
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
  let usage: ChatCompletionResponse["usage"];
  let finish = "stop";
  for await (const line of streamLines(res.body)) {
    const jsonStr = parseDataLine(line);
    if (jsonStr === null) continue;
    let chunk: ChatCompletionChunk;
    try { chunk = JSON.parse(jsonStr) as ChatCompletionChunk; } catch { continue; }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta;
    if (d?.content) content += d.content;
    const rc = (d as { reasoning_content?: string } | undefined)?.reasoning_content;
    if (rc) reasoning += rc;
    if (Array.isArray(d?.tool_calls)) {
      for (const t of d!.tool_calls!) {
        const idx = t.index ?? 0;
        const e = toolCalls.get(idx) ?? { args: "" };
        if (t.id) e.id = t.id;
        if (t.function?.name) e.name = (e.name ?? "") + t.function.name;
        if (t.function?.arguments) e.args += t.function.arguments;
        toolCalls.set(idx, e);
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const calls: ToolCall[] = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, e]) => ({
      id: e.id ?? `call_${idx}`,
      type: "function" as const,
      function: { name: e.name ?? "", arguments: e.args || "{}" },
    }));
  const json: ChatCompletionResponse = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: (calls.length ? "tool_calls" : finish) as ChatCompletionResponse["choices"][number]["finish_reason"],
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  if (persona) translateResponse(json, persona.map);
  void reasoning;
  return json;
}

/**
 * Live model discovery — GET /zen/v1/models is public. Falls back to a
 * static list when the upstream is down or unreachable.
 */
export async function listOpencodeModels(cfg: OpencodeConfig = {}): Promise<string[]> {
  const base = (cfg.baseUrl ?? BASE_URL).replace(/\/$/, "");
  const apiKey = cfg.apiKey ?? getOpencodeApiKey();
  try {
    const res = await fetch(`${base}/zen/v1/models`, {
      headers: { Authorization: apiKey ? `Bearer ${apiKey}` : PUBLIC_BEARER, "User-Agent": "opencode" },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      if (Array.isArray(data.data)) {
        return data.data.map((m) => `opencode/${m.id}`).filter(Boolean);
      }
    }
  } catch {
    /* fall through to static list */
  }
  return STATIC_MODELS;
}

/** Static fallback list — mirrors rara-agent's MODELS_WHITELIST. */
export const STATIC_MODELS = [
  "opencode/big-pickle",
  "opencode/claude-sonnet-4",
  "opencode/claude-haiku-4-5",
  "opencode/claude-opus-4",
  "opencode/gpt-5.4",
  "opencode/gpt-5.4-mini",
  "opencode/gpt-5.1-codex",
  "opencode/gemini-3.5-flash",
  "opencode/gemini-3.6-flash",
  "opencode/glm-5.3-flash",
  "opencode/deepseek-v4-flash",
  "opencode/qwen3.8-flash",
  "opencode/kimi-k3",
  "opencode/mistral-large-4",
  "opencode/grok-4.7",
  "opencode/muse-spark-1.3",
  "opencode/jev-1.13-free",
  "opencode/exo-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/space-bunny-free",
];
