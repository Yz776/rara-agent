/**
 * OpenCodeExecutor — opencode.ai Zen gateway (ported from 9Router).
 *
 * OpenCode exposes an OpenAI-compatible chat API with two quirks:
 *  1. Auth is `Authorization: Bearer public` when no user key is configured
 *     (the free tier). A real key from https://opencode.ai/auth unlocks more
 *     models and is used as the bearer when present.
 *  2. muse-spark models are only served by the Responses API
 *     (`/zen/v1/responses`) — requests must be reshaped (input parts,
 *     max_output_tokens, reasoning:{effort,summary}) and the SSE events
 *     translated back into OpenAI chat chunks.
 *
 * Identity headers (x-opencode-session/request/project) mirror the desktop
 * client, as in 9Router's executor. Model discovery is live: GET /zen/v1/models
 * is public, so the static catalog is only a fallback.
 */

import crypto from "node:crypto";
import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelListResponse,
  ModelObject,
  ToolCall,
} from "../types";
import { fetchWithRetry } from "../utils/retry";
import { parseDataLine, streamLines } from "../utils/stream";
import { wrapWithPersona, translateResponse, translateStream } from "./opencode-persona";

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
      // Tool results are not supported on responses models — flatten to text.
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: String(m.content ?? "") }] satisfies ResponsesInputPart[],
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown }).tool_calls)) {
      // Assistant tool-call turns can't be expressed here — keep the text only.
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: typeof m.content === "string" ? m.content : "" }] satisfies ResponsesInputPart[],
      });
      continue;
    }
    let parts: ResponsesInputPart[];
    if (typeof m.content === "string") {
      parts = [{ type: "input_text", text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = m.content.map((c) => {
        const part = c as { type?: string; text?: string; image_url?: { url?: string } };
        if (part.type === "image_url" && part.image_url?.url) {
          return { type: "input_image", image_url: part.image_url.url } as ResponsesInputPart;
        }
        return { type: "input_text", text: part.text ?? "" } as ResponsesInputPart;
      });
    } else {
      parts = [{ type: "input_text", text: "" }];
    }
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
  // Responses models here reject function tools — drop them (capability shim).
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

export class OpenCodeExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "openai" as const;
  category: "api_key" | "free_tier" | "oauth" | "self_hosted" = "free_tier";

  protected apiKey: string;
  protected baseUrl: string;
  protected staticModels: ModelObject[];
  protected sessionId = generateSessionId();
  protected projectId = generateProjectId();

  constructor(options: { id?: string; name?: string; baseUrl?: string; apiKey?: string; models?: ModelObject[] } = {}) {
    this.id = options.id ?? "opencode";
    this.name = options.name ?? "OpenCode";
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? "";
    this.staticModels = options.models ?? [];
  }

  updateApiKey(apiKey: string): void {
    if (apiKey) this.apiKey = apiKey;
  }

  updateToken(accessToken: string): void {
    this.updateApiKey(accessToken);
  }

  protected getHeaders(stream: boolean): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: this.apiKey ? `Bearer ${this.apiKey}` : PUBLIC_BEARER,
      "User-Agent": "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
      "x-opencode-client": "cli",
      "x-opencode-session": this.sessionId,
      "x-opencode-request": generateRequestId(),
      "x-opencode-project": this.projectId,
      Accept: stream ? "text/event-stream" : "*/*",
    };
  }

  protected buildUrl(targetModel: string): string {
    return isResponsesModel(targetModel)
      ? `${this.baseUrl}/zen/v1/responses`
      : `${this.baseUrl}/zen/v1/chat/completions`;
  }

  async listModels(): Promise<ModelObject[]> {
    try {
      const res = await fetch(`${this.baseUrl}/zen/v1/models`, {
        headers: { Authorization: this.apiKey ? `Bearer ${this.apiKey}` : PUBLIC_BEARER, "User-Agent": "opencode" },
      });
      if (res.ok) {
        const data = (await res.json()) as ModelListResponse;
        if (Array.isArray(data.data)) {
          return data.data.map((m) => ({
            id: `opencode/${m.id}`,
            object: "model" as const,
            owned_by: "opencode",
            capabilities: {
              streaming: true,
              tools: !m.id.startsWith("muse-spark"),
              vision: true,
              reasoning: false,
            },
          }));
        }
      }
    } catch {
      /* fall through to static list */
    }
    return this.staticModels;
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const targetModel = req.model.replace(/^opencode\//, "");
    const url = this.buildUrl(targetModel);

    if (isResponsesModel(targetModel)) {
      // Non-streaming via Responses API: collect the text deltas.
      let text = "";
      let usage: ChatCompletionResponse["usage"];
      for await (const chunk of this.responsesStream(url, targetModel, req)) {
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
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as ChatCompletionResponse;
    }

    const body = {
      ...req,
      model: targetModel,
      stream: false,
    };
    // Free-tier gate: without a real API key (empty OR "public"), opencode.ai
    // only serves requests that carry the real client's system prompt + tool
    // set AND stream:true. Wrap, force streaming upstream, and translate back.
    if (isFreeTier(this.apiKey)) {
      const persona = wrapWithPersona({ ...body, stream: true } as ChatCompletionRequest);
      const res = await fetchWithRetry(url, persona.body as unknown as Record<string, unknown>, this.getHeaders(true));
      if (!res.ok) {
        throw new Error(`OpenCode error (${res.status}): ${await res.text()}`);
      }
      if (!res.body) throw new Error("No response body received");
      // Accumulate the SSE stream into a non-streaming response.
      let content = "";
      let reasoning = "";
      const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
      let usage: ChatCompletionResponse["usage"];
      let finish = "stop";
      for await (const line of streamLines(res.body)) {
        const jsonStr = parseDataLine(line);
        if (jsonStr === null) continue;
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(jsonStr) as ChatCompletionChunk;
        } catch {
          continue;
        }
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
            message: {
              role: "assistant",
              content,
              ...(calls.length ? { tool_calls: calls } : {}),
            },
            finish_reason: (calls.length ? "tool_calls" : finish) as ChatCompletionResponse["choices"][number]["finish_reason"],
          },
        ],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      translateResponse(json, persona.map);
      return json;
    }

    const res = await fetchWithRetry(url, body, this.getHeaders(false));
    if (!res.ok) {
      throw new Error(`OpenCode error (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as ChatCompletionResponse;
    json.model = req.model;
    return json;
  }

  private async *responsesStream(
    url: string,
    targetModel: string,
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const body = toResponsesBody({ ...req, model: targetModel }, targetModel);
    const res = await fetchWithRetry(url, body, this.getHeaders(true));
    if (!res.ok) {
      throw new Error(`OpenCode error (${res.status}): ${await res.text()}`);
    }
    if (!res.body) throw new Error("No response body received for streaming");
    for await (const line of streamLines(res.body)) {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) continue;
      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>;
        for (const chunk of responsesEventToChunks(event, req)) {
          yield chunk;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("OpenCode responses error")) throw err;
        /* ignore malformed event */
      }
    }
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const targetModel = req.model.replace(/^opencode\//, "");
    const url = this.buildUrl(targetModel);

    if (isResponsesModel(targetModel)) {
      yield* this.responsesStream(url, targetModel, req);
      return;
    }

    const body = {
      ...req,
      model: targetModel,
      stream: true,
    };
    const persona = isFreeTier(this.apiKey) ? wrapWithPersona(body as ChatCompletionRequest) : null;
    const res = await fetchWithRetry(url, (persona?.body ?? body) as unknown as Record<string, unknown>, this.getHeaders(true));
    if (!res.ok) {
      throw new Error(`OpenCode stream error (${res.status}): ${await res.text()}`);
    }
    if (!res.body) throw new Error("No response body received for streaming");
    const raw = (async function* () {
      for await (const line of streamLines(res.body!)) {
        const jsonStr = parseDataLine(line);
        if (jsonStr === null) continue;
        try {
          const parsed = JSON.parse(jsonStr) as ChatCompletionChunk;
          parsed.model = req.model;
          yield parsed;
        } catch {
          /* ignore malformed JSON chunk */
        }
      }
    })();
    if (persona) {
      yield* translateStream(raw, persona.map);
      return;
    }
    yield* raw;
  }
}
