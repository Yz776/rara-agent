/**
 * Provider Executor Template
 * 
 * Extend this class to create new AI provider support
 * 
 * Required methods:
 *  - updateApiKey(apiKey: string): void
 *  - getHeaders(stream: boolean): Record<string, string>
 *  - listModels(): Promise<ModelObject[]>
 *  - chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>
 *  - chatCompletionStream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk>
 */

import type {
  AIProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelListResponse,
  ModelObject,
} from "../types";
import { fetchWithRetry } from "../utils/retry";

export abstract class ProviderExecutor implements AIProvider {
  abstract id: string;
  abstract name: string;
  protocol = "openai" as const;
  abstract category: "api_key" | "free_tier" | "oauth" | "self_hosted";
  
  protected apiKey: string = "";
  protected baseUrl: string = "";
  protected timeout: number = 120000;
  
  updateApiKey(apiKey: string): void {
    if (apiKey) this.apiKey = apiKey;
  }
  
  abstract getHeaders(stream: boolean): Record<string, string>;
  abstract buildUrl(path: string): string;
  
  async listModels(): Promise<ModelObject[]> {
    try {
      const res = await fetch(this.buildUrl("/models"), {
        headers: this.getHeaders(false),
      });
      
      if (!res.ok) return [];
      
      const data = (await res.json()) as ModelListResponse;
      return (data.data ?? []).map((m: any) => ({
        id: `custom/${m.id}`,
        object: "model",
        owned_by: "custom",
        capabilities: { streaming: true, tools: true, vision: false, reasoning: false },
      }));
    } catch {
      return [];
    }
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
  
  abstract chatCompletionStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk>;
}

import crypto from "node:crypto";
