/**
 * KRouter — Core Type Definitions
 *
 * OpenAI-compatible types used throughout the gateway.
 * These mirror the OpenAI Chat Completions API so the gateway can be
 * used as a drop-in replacement by AI agents (Claude Code, Cursor, Cline,
 * Continue, OpenCode, Codex, etc.).
 */

// ── JSON helpers ────────────────────────────────────────────────────────────
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JSONValue }
  | JSONValue[];

// ── Chat roles & messages ────────────────────────────────────────────────────
export type ChatRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "function"
  | "developer";

export interface ChatMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatMessageContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type ToolChoiceOption =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolFunctionParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolFunctionParameters {
  type: "object";
  properties?: Record<string, ToolFunctionParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: ToolFunctionParameters;
  };
}

// ── Chat completion request / response ───────────────────────────────────────
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoiceOption;
  response_format?: {
    type: string;
    json_schema?: JSONValue;
    name?: string;
    strict?: boolean;
    [key: string]: JSONValue | undefined;
  };
  reasoning_effort?: "none" | "low" | "medium" | "high" | (string & {});
  reasoning?: { effort?: string; summary?: string };
  // Allow extra provider-specific fields to pass through
  [key: string]: unknown;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | null;

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: FinishReason;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: UsageInfo;
  system_fingerprint?: string;
}

// ── Streaming chunks ──────────────────────────────────────────────────────────
export interface ChatCompletionChunkDeltaToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionChunkDelta {
  role?: ChatRole;
  content?: string;
  reasoning_content?: string;
  tool_calls?: ChatCompletionChunkDeltaToolCall[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: FinishReason;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: UsageInfo;
}

// ── Models API ────────────────────────────────────────────────────────────────
export interface ModelObject {
  id: string;
  object: "model";
  created?: number;
  owned_by: string;
  /** Free-form capabilities hints used by the router. */
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
  };
}

export interface ModelListResponse {
  object: "list";
  data: ModelObject[];
}

// ── Provider interface ─────────────────────────────────────────────────────────
export interface AIProvider {
  id: string;
  name: string;
  /** "openai" = OpenAI-compatible, "scrape" = custom scraper adapter. */
  protocol: "openai" | "scrape";
  /** Category used for the dashboard grouping. */
  category: "api_key" | "free_tier" | "oauth" | "self_hosted";

  listModels(): Promise<ModelObject[]>;
  chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatCompletionStream(
    req: ChatCompletionRequest
  ): AsyncGenerator<ChatCompletionChunk, void, void>;
}

// ── Error helpers ─────────────────────────────────────────────────────────────
export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}
