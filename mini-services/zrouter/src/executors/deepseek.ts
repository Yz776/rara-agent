import crypto from "node:crypto";
import type { AIProvider, ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { fetchWithRetry } from "../utils/retry";

const BASE_URL = "https://api.deepseek.com/v1";

export class DeepSeekExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "openai" as const;
  category: "api_key" | "free_tier" | "oauth" | "self_hosted" = "api_key";

  protected apiKey: string;
  protected baseUrl: string;

  constructor(options: { id?: string; name?: string; baseUrl?: string; apiKey?: string } = {}) {
    this.id = options.id ?? "deepseek";
    this.name = options.name ?? "DeepSeek";
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? "";
  }

  updateApiKey(apiKey: string): void {
    if (apiKey) this.apiKey = apiKey;
  }

  getHeaders(stream: boolean): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      Accept: stream ? "text/event-stream" : "*/*",
      "User-Agent": "KRouter/2.0",
    };
  }

  async listModels(): Promise<any[]> {
    return [
      { id: "deepseek-chat", object: "model", owned_by: "deepseek", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
      { id: "deepseek-coder", object: "model", owned_by: "deepseek", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
    ];
  }

  buildUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    let text = "";
    for await (const c of this.chatCompletionStream(req)) {
      text += c.choices?.[0]?.delta?.content ?? "";
    }
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async *chatCompletionStream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const url = this.buildUrl("/chat/completions");
    const body = { ...req, model: req.model.replace(/^deepseek\//, ""), stream: true };
    const res = await fetchWithRetry(url, body, this.getHeaders(true));
    if (!res.ok) throw new Error(`DeepSeek error (${res.status}): ${await res.text()}`);
    if (!res.body) throw new Error("No response body");
    const encoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += encoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const jsonStr = line.substring(5).trim();
          if (jsonStr === "[DONE]") continue;
          try {
            const data = JSON.parse(jsonStr);
            yield {
              id: data.id,
              object: data.object,
              created: data.created,
              model: req.model,
              choices: data.choices,
            };
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    }
    yield {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }
}
