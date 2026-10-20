/**
 * OpenAIExecutor — generic OpenAI-compatible provider.
 *
 * This is the foundation executor. Every provider whose API mirrors the
 * OpenAI Chat Completions spec (Groq, Together, OpenRouter, Cerebras,
 * Fireworks, xAI, Mistral, OpenAI itself, BluesMinds, GoRouter, SeekAI, ...)
 * reuses this class and only overrides the baseUrl / auth headers.
 *
 * Responsibilities:
 *  - list models (GET /models)
 *  - non-streaming chat completion
 *  - streaming chat completion (SSE)
 *  - retry on transient errors
 *  - drop tools when the upstream rejects tool calls (model capability shim)
 *  - clamp max_tokens when upstream reports the limit in a 400 error
 *
 * Output shape is always standard OpenAI Chat Completions — this is what makes
 * the gateway safe to point AI agents (Claude Code, Cursor, Cline, Codex, ...)
 * at, regardless of which underlying provider serves the request.
 */

import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelListResponse,
  ModelObject,
} from "../types";
import { isToolCallingNotSupportedError, fetchWithRetry } from "../utils/retry";
import { parseDataLine, streamLines } from "../utils/stream";

export interface OpenAIExecutorOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  accessToken?: string;
  /** Optional static model list — used when /models is not available. */
  models?: ModelObject[];
  /** Custom header builder for providers that need non-Bearer auth. */
  buildHeaders?: (base: Record<string, string>) => Record<string, string>;
  /** Strip the provider prefix when sending the model name upstream. */
  stripProviderPrefix?: boolean;
  /** Extra body fields to inject (e.g. provider-specific defaults). */
  extraBody?: Record<string, unknown>;
}

function defaultStripProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function stripToolsFromRequest(req: ChatCompletionRequest): ChatCompletionRequest {
  const stripped = { ...req };
  delete stripped.tools;
  delete stripped.tool_choice;
  return stripped;
}

/** Parse the upstream max_tokens limit from a 400 error body. */
function parseMaxTokensLimit(errorBody: string): number | null {
  try {
    const parsed = JSON.parse(errorBody) as {
      error?: { message?: string; param?: string };
    };
    if (parsed?.error?.param === "max_tokens" && parsed.error.message) {
      const match = parsed.error.message.match(
        /(?:less than or equal to|max(?:imum)?(?:\s+value)?(?:\s+(?:for|is))?[:\s]+)\s*`?(\d+)`?/i
      );
      if (match) return Number(match[1]);
    }
  } catch {
    /* fall through */
  }
  if (errorBody.includes('"param"') && errorBody.includes('"max_tokens"')) {
    const match = errorBody.match(
      /(?:less than or equal to|max(?:imum)?(?:\s+value)?(?:\s+(?:for|is))?[:\s]+)\s*`?(\d+)`?/i
    );
    if (match) return Number(match[1]);
  }
  return null;
}

export class OpenAIExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "openai" as const;
  category: "api_key" | "free_tier" | "oauth" | "self_hosted" = "api_key";

  protected baseUrl: string;
  protected apiKey: string;
  protected accessToken: string;
  protected staticModels: ModelObject[];
  protected buildHeaders?: (base: Record<string, string>) => Record<string, string>;
  protected stripPrefix: boolean;
  protected extraBody?: Record<string, unknown>;

  constructor(options: OpenAIExecutorOptions = {}) {
    this.id = options.id ?? "openai";
    this.name = options.name ?? "OpenAI Provider";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = options.apiKey ?? "";
    this.accessToken = options.accessToken ?? "";
    this.staticModels = options.models ?? [];
    this.buildHeaders = options.buildHeaders;
    this.stripPrefix = options.stripProviderPrefix ?? true;
    this.extraBody = options.extraBody;
  }

  updateToken(accessToken: string): void {
    if (accessToken) this.accessToken = accessToken;
  }

  updateApiKey(apiKey: string): void {
    if (apiKey) this.apiKey = apiKey;
  }

  protected getHeaders(accept?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "KRouter/1.0.0 (Bun)",
      "Accept-Encoding": "identity",
      Accept: accept ?? "application/json",
    };
    const token = this.accessToken || this.apiKey;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      // Gemini / Vertex OAuth tokens: also set x-goog-api-key / x-goog-api-client
      if (token.startsWith("AIzaSy")) {
        headers["x-goog-api-key"] = token;
      } else if (token.startsWith("ya29.")) {
        headers["User-Agent"] = "Antigravity/1.0 (VSCode)";
        headers["x-goog-api-client"] = "gl-node/18.0.0 gd/1.0.0";
      }
    }
    return this.buildHeaders ? this.buildHeaders(headers) : headers;
  }

  async listModels(): Promise<ModelObject[]> {
    if (this.staticModels.length > 0) return this.staticModels;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as ModelListResponse;
      if (!data.data || !Array.isArray(data.data)) return [];
      const baseId = this.id.split("_")[0]?.split("-")[0] ?? this.id;
      return data.data.map((m) => ({
        id: `${baseId}/${m.id}`,
        object: "model" as const,
        owned_by: baseId,
      }));
    } catch {
      return [];
    }
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const targetModel = this.stripPrefix
      ? defaultStripProviderPrefix(req.model)
      : req.model;
    const url = `${this.baseUrl}/chat/completions`;
    const hdrs = this.getHeaders();

    const body: Record<string, unknown> = {
      ...req,
      ...this.extraBody,
      model: targetModel,
      stream: false,
    };

    let res = await fetchWithRetry(url, body, hdrs);

    if (!res.ok) {
      const errorText = await res.text();

      // Retry without tools when upstream rejects tool calls
      if (
        isToolCallingNotSupportedError(errorText) &&
        req.tools &&
        req.tools.length > 0
      ) {
        const strippedReq = stripToolsFromRequest({
          ...body,
          model: targetModel,
          stream: false,
        } as ChatCompletionRequest);
        res = await fetchWithRetry(url, strippedReq, hdrs, 1);
        if (!res.ok) {
          throw new Error(
            `${this.name} error (${res.status}): ${await res.text()}`
          );
        }
        return (await res.json()) as ChatCompletionResponse;
      }

      // Clamp max_tokens when the upstream reports the real limit
      const limit = parseMaxTokensLimit(errorText);
      if (limit !== null && (req.max_tokens ?? 0) > limit) {
        const clampedReq = {
          ...body,
          model: targetModel,
          stream: false,
          max_tokens: limit,
        };
        res = await fetchWithRetry(url, clampedReq, hdrs, 1);
        if (!res.ok) {
          throw new Error(
            `${this.name} error (${res.status}): ${await res.text()}`
          );
        }
      } else {
        throw new Error(`${this.name} error (${res.status}): ${errorText}`);
      }
    }

    return (await res.json()) as ChatCompletionResponse;
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk, void, void> {
    const targetModel = this.stripPrefix
      ? defaultStripProviderPrefix(req.model)
      : req.model;
    const url = `${this.baseUrl}/chat/completions`;
    const hdrs = this.getHeaders("text/event-stream, application/json, */*");

    const body: Record<string, unknown> = {
      ...req,
      ...this.extraBody,
      model: targetModel,
      stream: true,
    };

    let res = await fetchWithRetry(url, body, hdrs);

    if (!res.ok) {
      const errorText = await res.text();
      if (
        isToolCallingNotSupportedError(errorText) &&
        req.tools &&
        req.tools.length > 0
      ) {
        const strippedReq = stripToolsFromRequest({
          ...body,
          model: targetModel,
          stream: true,
        } as ChatCompletionRequest);
        res = await fetchWithRetry(url, strippedReq, hdrs, 1);
        if (!res.ok) {
          throw new Error(
            `${this.name} stream error (${res.status}): ${await res.text()}`
          );
        }
      } else {
        const limit = parseMaxTokensLimit(errorText);
        if (limit !== null && (req.max_tokens ?? 0) > limit) {
          const clampedReq = {
            ...body,
            model: targetModel,
            stream: true,
            max_tokens: limit,
          };
          res = await fetchWithRetry(url, clampedReq, hdrs, 1);
          if (!res.ok) {
            throw new Error(
              `${this.name} stream error (${res.status}): ${await res.text()}`
            );
          }
        } else {
          throw new Error(
            `${this.name} stream error (${res.status}): ${errorText}`
          );
        }
      }
    }

    if (!res.body) {
      throw new Error("No response body received for streaming");
    }

    for await (const line of streamLines(res.body)) {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) continue;
      try {
        const parsed = JSON.parse(jsonStr) as ChatCompletionChunk;
        // Force the model field to the requested alias so agents see a stable id
        parsed.model = req.model;
        yield parsed;
      } catch {
        /* ignore malformed JSON chunk */
      }
    }
  }
}
