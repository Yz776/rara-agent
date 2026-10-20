/**
 * GeminiScraperExecutor — scrapes gemini.google.com directly (ported from gemini.js by wolep).
 *
 * Uses the web chat UI's internal API:
 *   - Cookie-based auth (auto-fetched on first request)
 *   - Session persistence via resumeArray + cookie (base64 encoded)
 *   - Single endpoint: /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 *   - Returns SSE-like response parsed into OpenAI-compatible stream
 *
 * Models exposed (prefixed `gemini/`):
 *   - gemini/gemini-2.5-pro
 *   - gemini/gemini-2.5-flash
 *   - gemini/gemini-2.0-flash
 *   - gemini/gemini-2.0-flash-thinking
 *   - gemini/gemini-1.5-pro
 *   - gemini/gemini-1.5-flash
 *
 * Auth: no API key needed — cookie auto-fetched from gemini.google.com.
 * Optional: pass a `session` string (from previous response) to continue conversation.
 * The session is returned as base64 JSON {cookie, resumeArray}.
 */

import crypto from "node:crypto";
import https from "node:https";
import { Agent } from "node:https";
import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../types";
import { makeChatId, estimateTokens } from "../utils/stream";

const DEFAULT_BASE_URL = "https://gemini.google.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const ENDPOINT = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20260917.13_p0&f.sid=1147530711385426743&hl=en-US&_reqid=2011320&rt=c";

const GEMINI_AGENT = new Agent({
  maxHeaderSize: 262_144, // 256KB to handle large CSP/Set-Cookie headers from Google
  keepAlive: true,
});

const GEMINI_MODELS: ModelObject[] = [
  { id: "gemini/gemini-2.5-pro", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: true } },
  { id: "gemini/gemini-2.5-flash", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: true } },
  { id: "gemini/gemini-2.0-flash", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
  { id: "gemini/gemini-2.0-flash-thinking", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: true } },
  { id: "gemini/gemini-1.5-pro", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
  { id: "gemini/gemini-1.5-flash", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
];

interface GeminiSession {
  cookie: string;
  resumeArray: unknown[];
}

function decodeSession(sessionB64: string): GeminiSession | null {
  try {
    const json = Buffer.from(sessionB64, "base64").toString("utf8");
    const obj = JSON.parse(json);
    if (obj.cookie && Array.isArray(obj.resumeArray)) return obj;
  } catch { /* ignore */ }
  return null;
}

function encodeSession(session: GeminiSession): string {
  return Buffer.from(JSON.stringify(session)).toString("base64");
}

export interface GeminiScraperExecutorOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  token?: string; // not used, kept for interface compatibility
  models?: ModelObject[]; // static model list (from catalog)
}

export class GeminiScraperExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "scrape" as const;
  category = "api_key" as const;

  private baseUrl: string;
  private session: GeminiSession | null = null;
  private staticModels: ModelObject[];

  constructor(options: GeminiScraperExecutorOptions = {}) {
    this.id = options.id ?? "gemini-web";
    this.name = options.name ?? "Gemini (Web Scraper)";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.staticModels = options.models ?? [];
    // token is ignored — cookie auto-fetched
  }

  updateToken(token: string): void {
    // Accept a base64-encoded session string for continuity
    const decoded = decodeSession(token);
    if (decoded) this.session = decoded;
  }

  private async fetchCookie(): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl);
      const req = https.request(
        {
          hostname: url.hostname,
          path: "/",
          method: "HEAD",
          headers: {
            "User-Agent": UA,
            "Accept-Encoding": "gzip, deflate, br, zstd",
          },
          timeout: 15_000,
          agent: GEMINI_AGENT,
          maxHeaderSize: 262_144, // Google sends ~20KB+ CSP headers; default 16KB overflows
        },
        (res) => {
          const cookies = res.headers["set-cookie"] as string[] | undefined;
          // Keep ONLY the NID cookie (main Google auth) to avoid header overflow
          const nidCookie = cookies
            ?.map((c) => c.split("; ")[0])
            .find((c) => c.startsWith("NID="));
          const cookie = nidCookie || cookies?.[0]?.split("; ")?.[0];
          if (cookie) resolve(cookie);
          else reject(new Error("Failed to get cookie from gemini.google.com"));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Cookie fetch timeout")); });
      req.end();
    });
  }

  private async ensureSession(): Promise<GeminiSession> {
    if (this.session) return this.session;
    const cookie = await this.fetchCookie();
    this.session = { cookie, resumeArray: [] };
    return this.session;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const sess = this.session;
    return {
      Accept: "*/*",
      "User-Agent": UA,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Cookie: sess?.cookie ?? "",
      ...extra,
    };
  }

  private async request(body: URLSearchParams): Promise<import("node:stream").Readable> {
    const bodyStr = body.toString();
    const url = this.baseUrl + ENDPOINT;

    try {
      // Use raw HTTPS request with custom Agent to control header size
      const https = await import("node:https");
      const { Readable } = await import("node:stream");
      
      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: new URL(url).hostname,
            path: new URL(url).pathname + new URL(url).search,
            method: "POST",
            headers: this.headers({
              "Content-Length": String(Buffer.byteLength(bodyStr)),
            }),
            timeout: 60_000,
            agent: GEMINI_AGENT,
            maxHeaderSize: 262_144, // 256KB for large CSP/Set-Cookie headers from Google
          },
          (res) => {
            
            if (res.statusCode && res.statusCode >= 400) {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () =>
                reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`))
              );
              return;
            }
            
            // Update cookie if server sends new one — keep ONLY NID to avoid header overflow
            const newCookies = res.headers["set-cookie"] as string[] | undefined;
            if (newCookies && this.session) {
              const nidCookie = newCookies
                .map((c) => c.split("; ")[0])
                .find((c) => c.startsWith("NID="));
              if (nidCookie) this.session.cookie = nidCookie;
            }
            
            resolve(res);
          }
        );
        
        req.on("error", (err) => {
          console.error("[GeminiScraperExecutor] Request error:", err.message);
          reject(err);
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
        req.write(bodyStr);
        req.end();
      });
    } catch (err) {
      console.error("[GeminiScraperExecutor] Fetch error:", err);
      throw err;
    }
  }

  private extractPrompt(req: ChatCompletionRequest): string {
    return req.messages
      .map((msg) => {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
            ? msg.content.map((p) => (p as { text?: string }).text ?? "").join("")
            : "";
        if (msg.role === "system") return `[System] ${content}`;
        if (msg.role === "assistant") return `[Assistant] ${content}`;
        if (msg.role === "tool") return `[Tool ${msg.tool_call_id ?? ""}] ${content}`;
        return content;
      })
      .join("\n\n");
  }

  private buildBody(prompt: string, resumeArray: unknown[]): URLSearchParams {
    const fReq = JSON.stringify([
      null,
      JSON.stringify([[prompt], ["en-US"], resumeArray]),
    ]);
    return new URLSearchParams({ "f.req": fReq });
  }

  /**
   * Parse one StreamGenerate payload line: `["wrb.fr",null,"<json-string>",...]`.
   * The inner JSON carries cumulative text at [4][0][1][0] and conversation ids at [1].
   */
  private parsePayload(line: string): { content?: string; resumeArray?: unknown[] } | null {
    try {
      if (!line.startsWith("[[")) return null;
      const o = JSON.parse(line);
      const inner = o?.[0]?.[2];
      if (typeof inner !== "string") return null;
      const a = JSON.parse(inner);
      const content = a?.[4]?.[0]?.[1]?.[0];
      const resumeArray = Array.isArray(a?.[1]) ? [a[1][0], a[1][1], a?.[4]?.[0]?.[0]] : undefined;
      return {
        content: typeof content === "string" ? content.replace(/\*\*(.*?)\*\*/g, "*$1*") : undefined,
        resumeArray,
      };
    } catch {
      return null;
    }
  }

  /**
   * Buffer the raw chunked stream and yield one {content, resumeArray} per
   * StreamGenerate chunk. Content is cumulative per chunk; callers diff for deltas.
   */
  private async *parseStream(
    stream: import("node:stream").Readable
  ): AsyncGenerator<{ content: string; resumeArray?: unknown[] }, void, void> {
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk as unknown as Uint8Array, { stream: true });
      // Payload lines start with `[[` and are always newline-terminated; the
      // `)]}'` header appears only once at the top of the stream.
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("[[")) continue;
        const parsed = this.parsePayload(line);
        if (parsed?.content != null) yield { content: parsed.content, resumeArray: parsed.resumeArray };
      }
    }
    const tail = buf.trim();
    if (tail.startsWith("[[")) {
      const parsed = this.parsePayload(tail);
      if (parsed?.content != null) yield { content: parsed.content, resumeArray: parsed.resumeArray };
    }
  }

  async listModels(): Promise<ModelObject[]> {
    return this.staticModels.length > 0 ? this.staticModels : GEMINI_MODELS;
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const prompt = this.extractPrompt(req);
    await this.ensureSession();
    const body = this.buildBody(prompt, this.session!.resumeArray);
    const stream = await this.request(body);

    let content = "";
    let lastResumeArray = this.session!.resumeArray;

    for await (const ev of this.parseStream(stream)) {
      // Google sends cumulative text; keep the longest (final) version.
      if (ev.content.length > content.length) content = ev.content;
      if (ev.resumeArray) lastResumeArray = ev.resumeArray;
    }

    if (this.session) this.session.resumeArray = lastResumeArray;

    return {
      id: makeChatId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(content),
        total_tokens: estimateTokens(prompt) + estimateTokens(content),
      },
    };
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const prompt = this.extractPrompt(req);
    await this.ensureSession();
    const body = this.buildBody(prompt, this.session!.resumeArray);
    const res = await this.request(body);

    const chunkId = makeChatId();
    const created = Math.floor(Date.now() / 1000);

    // Announce assistant role
    yield {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    };

    let content = "";
    let lastResumeArray = this.session!.resumeArray;

    for await (const ev of this.parseStream(res)) {
      if (ev.content.length > content.length) {
        const delta = ev.content.slice(content.length);
        content = ev.content;
        yield {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model: req.model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        };
      }
      if (ev.resumeArray) lastResumeArray = ev.resumeArray;
    }

    if (this.session) this.session.resumeArray = lastResumeArray;

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    yield {
      id: chunkId,
      object: "chat.completion.chunk",
      created,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };
  }

  /** Get the current session as base64 string for external persistence. */
  getSession(): string | null {
    return this.session ? encodeSession(this.session) : null;
  }
}