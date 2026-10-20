/**
 * Anthropic Provider Executor
 * 
 * Supports:
 *  - /v1/messages endpoint
 *  - Stream & non-stream modes
 *  - Tool calling (native)
 */

import crypto from "node:crypto";

import crypto from "node:crypto";
import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelObject,
} from "../types";
import { fetchWithRetry } from "../utils/retry";
import { parseDataLine, streamLines } from "../utils/stream";

const BASE_URL = "https://api.anthropic.com/v1";

export class AnthropicExecutor implements AIProvider {
  id: string;
  name: string;
  protocol = "openai" as const;
  category: "api_key" | "free_tier" | "oauth" | "self_hosted" = "api_key";
  
  protected apiKey: string;
  protected baseUrl: string;
  protected models: ModelObject[];
  
  constructor(options: { id?: string; name?: string; baseUrl?: string; apiKey?: string; models?: ModelObject[] } = {}) {
    this.id = options.id ?? "anthropic";
    this.name = options.name ?? "Anthropic";
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey ?? "";
    this.models = options.models ?? [];
  }
  
  updateApiKey(apiKey: string): void {
    if (apiKey) this.apiKey = apiKey;
  }
  
  private getHeaders(stream: boolean): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      Accept: stream ? "text/event-stream" : "*/*",
    };
  }
  
  async listModels(): Promise<ModelObject[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(false),
      });
      
      if (!res.ok) return this.models;
      
      const data = await res.json();
      return (data.data ?? []).map((m: any) => ({
        id: `anthropic/${m.id}`,
        object: "model",
        owned_by: "anthropic",
        capabilities: {
          streaming: m.streaming ?? true,
          tools: m.supports_tools ?? true,
          vision: m.supports_images ?? false,
          reasoning: m.supports_reasoning ?? false,
        },
      }));
    } catch {
      return this.models;
    }
  }
  
  private buildUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }
  
  async chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    let text = "";
    for await (const chunk of this.chatCompletionStream(req)) {
      text += chunk.choices?.[0]?.delta?.content ?? "";
    }
    
    return {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  
  async *chatCompletionStream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const model = req.model.replace(/^anthropic\//, "");
    const url = this.buildUrl("/messages");
    
    // Transform OpenAI format to Anthropic format
    const anthropicReq: Record<string, unknown> = {
      model,
      messages: this.transformMessages(req.messages),
      max_tokens: req.max_tokens ?? 4096,
      temperature: req.temperature ?? 1.0,
      top_p: req.top_p,
      stream: true,
    };
    
    if (req.tools && req.tools.length > 0) {
      anthropicReq.tools = req.tools;
    }
    
    const res = await fetchWithRetry(url, anthropicReq, this.getHeaders(true));
    if (!res.ok) {
      throw new Error(`Anthropic error (${res.status}): ${await res.text()}`);
    }
    
    if (!res.body) throw new Error("No response body");
    
    for await (const line of streamLines(res.body)) {
      const jsonStr = parseDataLine(line);
      if (jsonStr === null) continue;
      
      try {
        const data = JSON.parse(jsonStr);
        
        if (data.type === "message_start") {
          yield {
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: req.model,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          };
        } else if (data.type === "content_block_delta" || data.type === "content_block_start") {
          if (data.delta?.type === "text_delta") {
            yield {
              id: `chatcmpl-${crypto.randomUUID()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: req.model,
              choices: [{ index: 0, delta: { content: data.delta.text }, finish_reason: null }],
            };
          }
        } else if (data.type === "message_stop") {
          // End of message
        }
      } catch (err) {
        // Ignore parse errors
      }
    }
    
    // Send final stop chunk
    yield {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }
  
  private transformMessages(messages: Array<{ role: string; content: any }>): Array<any> {
    return messages.map((m) => {
      const role = m.role === "system" ? "user" : m.role;
      return {
        role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
    });
  }
}
