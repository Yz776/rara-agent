import crypto from "node:crypto";
import type { AIProvider, ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { fetchWithRetry } from "../utils/retry";

const BASE_URL = "https://api.groq.com/openai/v1";

export class GroqExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "openai" as const;
  category: "api_key" | "free_tier" | "oauth" | "self_hosted" = "api_key";
  
  protected apiKey: string;
  protected baseUrl: string;
  protected staticModels: Array<{ id: string; capabilities?: { streaming?: boolean } }>;
  
  constructor(options: { id?: string; name?: string; baseUrl?: string; apiKey?: string; models?: any[] } = {}) {
    this.id = options.id ?? "groq";
    this.name = options.name ?? "Groq";
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? "";
    this.staticModels = options.models ?? [];
  }
  
  updateApiKey(apiKey: string): void { if (apiKey) this.apiKey = apiKey; }
  
  private getHeaders(stream: boolean): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      Accept: stream ? "text/event-stream" : "*/*",
    };
  }
  
  async listModels(): Promise<any[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return [{ id: "meta-llama/Llama-3.2-3B-Instruct", capabilities: { streaming: true } },
                           { id: "mixtral-8x7b-32768", capabilities: { streaming: true } },
                           { id: "llama-3.1-8b-instant", capabilities: { streaming: true } },
                           { id: "gemma2-9b-it", capabilities: { streaming: true } }];
      const data = await res.json();
      return (data.data ?? []).map((m: any) => ({
        id: `groq/${m.id}`, object: "model", owned_by: "groq",
        capabilities: { streaming: true, tools: true, vision: false, reasoning: false },
      }));
    } catch { return [{ id: "meta-llama/Llama-3.2-3B-Instruct", capabilities: { streaming: true } }]; }
  }
  
  private buildUrl(path: string): string { return `${this.baseUrl}${path}`; }
  
  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    let text = ""; for await (const chunk of this.chatCompletionStream(req)) { text += chunk.choices?.[0]?.delta?.content ?? ""; }
    return { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now()/1000), model: req.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  
  async *chatCompletionStream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const url = this.buildUrl("/chat/completions");
    const body = { ...req, model: req.model.replace(/^groq\//, ""), stream: true };
    const res = await fetchWithRetry(url, body, this.getHeaders(true));
    if (!res.ok) throw new Error(`Groq error (${res.status}): ${await res.text()}`);
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
            yield { id: data.id, object: data.object, created: data.created, model: req.model, choices: data.choices };
          } catch {}
        }
      }
    }
    
    yield { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000),
      model: req.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  }
}
