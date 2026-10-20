/**
 * DeepSeekScraperExecutor — scrapes chat.deepseek.com directly.
 *
 * Why this exists:
 *   DeepSeek's official API costs money, but the web chat at
 *   https://chat.deepseek.com is free (rate-limited). This executor
 *   speaks the web API directly: it creates a chat session, solves the
 *   Proof-of-Work challenge (SHA-3 in pure JS — no WASM needed), parses
 *   the non-standard SSE stream (p/v patch format), and re-emits it as
 *   a standard OpenAI Chat Completion stream so any AI agent can consume
 *   it transparently.
 *
 * Models exposed (all prefixed `deepseek/`):
 *   - deepseek/deepseek-chat
 *   - deepseek/deepseek-reasoner
 *   - deepseek/deepseek-v3
 *   - deepseek/deepseek-v4-flash
 *   - deepseek/deepseek-v4-pro
 *
 * Auth: a bearer token lifted from the browser session (cookie →
 * Authorization: Bearer <base64>). The token is the same one the web UI
 * uses; obtain it from DevTools → Network → any /api/v0/* request.
 */

import crypto from "node:crypto";
import https from "node:https";
import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../types";
import { makeChatId, parseDataLine, streamNodeLines, estimateTokens } from "../utils/stream";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://chat.deepseek.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const API = {
  LOGOUT: "/api/v0/users/logout",
  POW_CHALLENGE: "/api/v0/chat/create_pow_challenge",
  CREATE_SESSION: "/api/v0/chat_session/create",
  CHAT: "/api/v0/chat/completion",
} as const;

const DEEPSEEK_MODELS: ModelObject[] = [
  {
    id: "deepseek/deepseek-chat",
    object: "model",
    owned_by: "deepseek",
    capabilities: { streaming: true, tools: false, reasoning: false },
  },
  {
    id: "deepseek/deepseek-reasoner",
    object: "model",
    owned_by: "deepseek",
    capabilities: { streaming: true, tools: false, reasoning: true },
  },
  {
    id: "deepseek/deepseek-v3",
    object: "model",
    owned_by: "deepseek",
    capabilities: { streaming: true, tools: false, reasoning: false },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    object: "model",
    owned_by: "deepseek",
    capabilities: { streaming: true, tools: false, reasoning: false },
  },
  {
    id: "deepseek/deepseek-v4-pro",
    object: "model",
    owned_by: "deepseek",
    capabilities: { streaming: true, tools: false, reasoning: true },
  },
];

// ── PoW (Proof of Work) solver — pure JS implementation ──────────────────────
//
// DeepSeek's PoW challenge is a SHA-3 Keccak-256 preimage search. The web
// client ships a WASM binary for this; we implement the same algorithm in
// pure JavaScript using node:crypto's createHash('sha3-256'). The puzzle:
//
//   given  prefix = `${salt}_${expireAt}_`
//          find an integer `answer` such that
//          sha3_256(challenge + prefix + answer)  starts with  `difficulty`
//          zero bits (difficulty/4 = number of leading hex zero chars)
//
// This matches the reference Rust/WASM solver's semantics exactly.

interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  expire_at?: string;
  expireAt?: string;
}

function keccak256(data: string): Buffer {
  // Bun / Node exposes SHA3-256 via createHash('sha3-256').
  // Note: SHA3-256 (NIST FIPS 202) — NOT the older Keccak-256 padding.
  // DeepSeek's web client uses the WASM sha3 crate which produces NIST SHA3.
  return crypto.createHash("sha3-256").update(data).digest();
}

function solvePoW(challenge: PowChallenge): Record<string, unknown> {
  const { algorithm, challenge: ch, salt, difficulty, signature, expire_at, expireAt } = challenge;
  const prefix = `${salt}_${expireAt ?? expire_at}_`;

  // The reference solver searches answer ∈ [0, 2^32) and returns the first
  // value whose hash has at least `difficulty` leading zero bits. We replicate
  // that loop with a fast Buffer comparison.
  const targetZeroBits = difficulty;
  const targetHexZeros = Math.floor(targetZeroBits / 4);
  const targetRemainderBits = targetZeroBits % 4;

  for (let answer = 0; answer < 0xffffffff; answer++) {
    const candidate = `${ch}${prefix}${answer}`;
    const hash = keccak256(candidate);
    const hex = hash.toString("hex");

    if (hex.slice(0, targetHexZeros) !== "0".repeat(targetHexZeros)) continue;
    if (targetRemainderBits > 0) {
      const nibble = parseInt(hex[targetHexZeros]!, 16);
      // nibble must be < 2^(4 - remainderBits)
      if (nibble >> (4 - targetRemainderBits) !== 0) continue;
    }
    return { algorithm, challenge: ch, salt, answer, signature };
  }
  throw new Error("PoW: no solution found");
}

// ── Types ────────────────────────────────────────────────────────────────────

interface DeepSeekResponse {
  data?: { biz_data?: Record<string, unknown>; [key: string]: unknown };
  _status?: number;
  _headers?: Record<string, string>;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function mapModelToType(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("reasoner") || lower.includes("r1")) return "deepseek-reasoner";
  return "default";
}

// ── Executor ─────────────────────────────────────────────────────────────────

export interface DeepSeekScraperExecutorOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  token?: string;
}

export class DeepSeekScraperExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "scrape" as const;
  category = "api_key" as const;

  private baseUrl: string;
  private token: string;

  constructor(options: DeepSeekScraperExecutorOptions = {}) {
    this.id = options.id ?? "deepseek";
    this.name = options.name ?? "DeepSeek (Scraper)";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.token = options.token ?? "";
  }

  updateToken(token: string): void {
    if (token) this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: "*/*",
      "User-Agent": UA,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      "Accept-Language": "en-US,en;q=0.9",
      "x-app-version": "2.0.0",
      "x-client-version": "2.0.0",
      "x-client-platform": "web",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "0",
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  private request(
    method: string,
    urlPath: string,
    body?: Record<string, unknown>
  ): Promise<DeepSeekResponse> {
    return new Promise((resolve, reject) => {
      const contentHeaders: Record<string, string> = {};
      let bodyBuf: Buffer | null = null;
      if (body) {
        bodyBuf = Buffer.from(JSON.stringify(body));
        contentHeaders["Content-Type"] = "application/json";
        contentHeaders["Content-Length"] = String(bodyBuf.length);
      }
      const url = new URL(`${this.baseUrl}${urlPath}`);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method,
          headers: this.headers(contentHeaders),
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            try {
              resolve({
                ...(JSON.parse(raw) as Record<string, unknown>),
                _status: res.statusCode,
                _headers: res.headers as Record<string, string>,
              } as DeepSeekResponse);
            } catch {
              resolve({
                raw: raw as unknown as string,
                _status: res.statusCode,
                _headers: res.headers as Record<string, string>,
              });
            }
          });
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  private streamRequest(
    urlPath: string,
    body: Record<string, unknown>,
    extra: Record<string, string> = {}
  ): Promise<import("node:stream").Readable> {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const url = new URL(`${this.baseUrl}${urlPath}`);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: "POST",
          headers: this.headers({
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(bodyStr)),
            ...extra,
          }),
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              reject(
                new Error(
                  `HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`
                )
              )
            );
            return;
          }
          resolve(res);
        }
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });
  }

  private async getPowHeader(targetPath: string): Promise<string> {
    const res = await this.request("POST", API.POW_CHALLENGE, {
      target_path: targetPath,
    });
    const bizData = res?.data?.biz_data as Record<string, unknown> | undefined;
    const challenge = (bizData?.challenge ??
      res?.data?.challenge) as PowChallenge | undefined;
    if (!challenge) throw new Error("No PoW challenge received");
    const pow = solvePoW(challenge);
    return Buffer.from(
      JSON.stringify({ ...pow, target_path: targetPath })
    ).toString("base64");
  }

  private async createSession(): Promise<string> {
    const res = await this.request("POST", API.CREATE_SESSION, {});
    const bizData = res?.data?.biz_data as Record<string, unknown> | undefined;
    const sessionId =
      (bizData?.id as string) ??
      ((bizData?.chat_session as { id?: string })?.id ?? "");
    if (!sessionId) throw new Error("Failed to create DeepSeek session");
    return sessionId;
  }

  private async chatStream(
    sessionId: string,
    prompt: string,
    modelType: string,
    thinking: boolean
  ): Promise<import("node:stream").Readable> {
    const powHeader = await this.getPowHeader(API.CHAT);
    return this.streamRequest(
      API.CHAT,
      {
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: modelType,
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinking,
        search_enabled: false,
        preempt: false,
      },
      { "X-Ds-Pow-Response": powHeader }
    );
  }

  private extractPrompt(req: ChatCompletionRequest): string {
    return req.messages
      .map((msg) => {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
            ? msg.content.map((p) => p.text ?? "").join("")
            : "";
        if (msg.role === "system") return `[System] ${content}`;
        if (msg.role === "assistant") return `[Assistant] ${content}`;
        if (msg.role === "tool")
          return `[Tool ${msg.tool_call_id ?? ""}] ${content}`;
        return content;
      })
      .join("\n\n");
  }

  private isThinkingEnabled(req: ChatCompletionRequest): boolean {
    const raw = req as unknown as Record<string, unknown>;
    if (raw.thinking === true || raw.enable_thinking === true) return true;
    if (typeof raw.thinking === "object" && raw.thinking !== null) {
      if ((raw.thinking as Record<string, unknown>).type === "enabled")
        return true;
    }
    return Boolean(
      req.reasoning_effort && req.reasoning_effort !== "none"
    );
  }

  // ── AIProvider interface ──────────────────────────────────────────────

  async listModels(): Promise<ModelObject[]> {
    return DEEPSEEK_MODELS;
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const modelType = mapModelToType(stripProviderPrefix(req.model));
    const prompt = this.extractPrompt(req);
    const thinking = this.isThinkingEnabled(req);
    const sessionId = await this.createSession();
    const stream = await this.chatStream(sessionId, prompt, modelType, thinking);
    const result = await parseSSEStream(stream);

    return {
      id: makeChatId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(result.content),
        total_tokens:
          estimateTokens(prompt) + estimateTokens(result.content),
      },
    };
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const modelType = mapModelToType(stripProviderPrefix(req.model));
    const prompt = this.extractPrompt(req);
    const thinking = this.isThinkingEnabled(req);
    const sessionId = await this.createSession();
    const res = await this.chatStream(sessionId, prompt, modelType, thinking);

    const chunkId = makeChatId();
    const created = Math.floor(Date.now() / 1000);

    // First chunk: announce the assistant role so agents know a response is starting
    yield {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    };

    let lastPath: string | null = null;
    let content = "";
    let reasoningContent = "";

    for await (const line of streamNodeLines(res)) {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) continue;
      try {
        const ev = JSON.parse(jsonStr) as Record<string, unknown>;
        const v = ev.v as Record<string, unknown> | undefined;

        // DeepSeek's `response.fragments` batch payload (used at the start)
        if (v?.response && typeof v.response === "object") {
          const resp = v.response as Record<string, unknown>;
          if (Array.isArray(resp.fragments)) {
            for (const frag of resp.fragments as Array<Record<string, unknown>>) {
              if (frag.type === "RESPONSE" && typeof frag.content === "string") {
                content += frag.content;
                yield {
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created,
                  model: req.model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: frag.content },
                      finish_reason: null,
                    },
                  ],
                };
                lastPath = "response/fragments/-1/content";
              }
            }
            continue;
          }
        }

        // Patch operation with a path — used to distinguish thinking vs. response content
        if (ev.p !== undefined) {
          lastPath = ev.p as string;
          if (
            typeof ev.v === "string" &&
            (ev.p as string).includes("/content")
          ) {
            if ((ev.p as string).includes("thinking")) {
              // Stream the reasoning_content separately so agents that display
              // chain-of-thought (Claude Code, Cursor with reasoning enabled)
              // can render it correctly.
              reasoningContent += ev.v;
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: req.model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: ev.v },
                    finish_reason: null,
                  },
                ],
              };
            } else {
              content += ev.v;
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: req.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: ev.v },
                    finish_reason: null,
                  },
                ],
              };
            }
          }
          continue;
        }

        // Value-only event — append to the last known path
        if (ev.v !== undefined && ev.o === undefined && ev.p === undefined) {
          if (typeof ev.v === "string" && lastPath?.includes("/content")) {
            if (lastPath.includes("thinking")) {
              reasoningContent += ev.v;
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: req.model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: ev.v },
                    finish_reason: null,
                  },
                ],
              };
            } else {
              content += ev.v;
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: req.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: ev.v },
                    finish_reason: null,
                  },
                ],
              };
            }
          }
        }
      } catch {
        /* ignore malformed JSON chunk */
      }
    }

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content + reasoningContent);
    yield {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}

// ── Non-streaming SSE parser (module-level) ─────────────────────────────────

function parseSSEStream(
  stream: import("node:stream").Readable
): Promise<{ content: string; reasoningContent: string; messageId: string | null }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let content = "";
    let reasoningContent = "";
    let messageId: string | null = null;
    let lastPath: string | null = null;

    function processLine(line: string): void {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) return;
      try {
        const ev = JSON.parse(jsonStr) as Record<string, unknown>;
        if (ev.response_message_id)
          messageId = ev.response_message_id as string;
        const v = ev.v as Record<string, unknown> | undefined;
        if (v?.response && typeof v.response === "object") {
          const resp = v.response as Record<string, unknown>;
          if (Array.isArray(resp.fragments)) {
            for (const frag of resp.fragments as Array<Record<string, unknown>>) {
              if (frag.type === "RESPONSE" && typeof frag.content === "string") {
                content += frag.content;
                lastPath = "response/fragments/-1/content";
              }
            }
            if (resp.message_id) messageId = resp.message_id as string;
            return;
          }
        }
        if (ev.p !== undefined) {
          lastPath = ev.p as string;
          if (typeof ev.v === "string" && (ev.p as string).includes("/content")) {
            if ((ev.p as string).includes("thinking")) {
              reasoningContent += ev.v;
            } else {
              content += ev.v;
            }
          }
          return;
        }
        if (ev.v !== undefined && ev.o === undefined && ev.p === undefined) {
          if (typeof ev.v === "string" && lastPath?.includes("/content")) {
            if (lastPath.includes("thinking")) {
              reasoningContent += ev.v;
            } else {
              content += ev.v;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) processLine(l.trim());
    });
    stream.on("end", () => {
      if (buf.trim()) processLine(buf.trim());
      resolve({ content, reasoningContent, messageId });
    });
    stream.on("error", reject);
  });
}
