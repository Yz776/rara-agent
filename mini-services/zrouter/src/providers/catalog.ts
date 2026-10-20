/**
 * Provider catalog — declares every provider the gateway knows about,
 * plus factory functions that build an executor instance on demand.
 *
 * Each provider definition is declarative so the dashboard and the router
 * share the same source of truth: base URL, default model list, auth mode,
 * whether it requires an API key, etc.
 */

import type { ModelObject } from "../types";
import { OpenAIExecutor } from "../executors/openai";
import { DeepSeekScraperExecutor } from "../executors/deepseek-scraper";
import { OpenCodeExecutor } from "../executors/opencode";
import { GeminiScraperExecutor } from "../executors/gemini-scraper";
import { GroqExecutor } from "../executors/groq";
import { DeepSeekExecutor } from "../executors/deepseek";
import { FireworksExecutor } from "../executors/fireworks";
import { AnthropicExecutor } from "../executors/anthropic";
import * as store from "../services/config-store";
import type { CustomProviderDefinition } from "../services/config-store";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProviderCategory =
  | "api_key"
  | "free_tier"
  | "oauth"
  | "self_hosted";

export type ProviderProtocol = "openai" | "scrape";

export interface ProviderStaticModels {
  id: string;
  object: "model";
  owned_by: string;
  capabilities?: ModelObject["capabilities"];
}

export interface ProviderDefinition {
  id: string;
  name: string;
  category: ProviderCategory;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Sign-up URL shown in the dashboard. */
  webUrl?: string;
  /** Whether an API key / token is required at runtime. */
  requiresApiKey: boolean;
  /** Whether the dashboard allows overriding baseUrl. */
  supportsCustomUrl: boolean;
  /** Status message shown when no credential is configured. */
  statusMessage?: string;
  /** Static model list (used when /models isn't public). */
  models?: ProviderStaticModels[];
  /** Optional alias prefix (e.g. `ds` for DeepSeek). */
  alias?: string;
  /** Custom header builder for providers with non-Bearer auth. */
  buildHeaders?: (base: Record<string, string>) => Record<string, string>;
}

// ── Static model lists ───────────────────────────────────────────────────────
//
// These come from each provider's public docs so `/v1/models` always returns
// something useful even when the upstream /models endpoint requires auth.

const GROQ_MODELS: ProviderStaticModels[] = [
  { id: "llama-3.3-70b-versatile", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "llama-3.1-8b-instant", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "llama-3.1-70b-versatile", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "mixtral-8x7b-32768", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "gemma2-9b-it", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "deepseek-r1-distill-llama-70b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "deepseek-r1-distill-qwen-32b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "qwen-2.5-32b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "qwen-2.5-coder-32b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen2.5-coder-32b-instruct", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "llama-3.3-70b-specdec", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "llama-guard-3-8b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "moonshotai/kimi-k2-instruct", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "openai/gpt-oss-120b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "openai/gpt-oss-20b", object: "model", owned_by: "groq", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const OPENROUTER_MODELS: ProviderStaticModels[] = [
  { id: "openai/gpt-4o", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "openai/gpt-4o-mini", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "openai/gpt-4-turbo", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "anthropic/claude-3.5-sonnet", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "anthropic/claude-3.5-haiku", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "anthropic/claude-3-opus", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "google/gemini-pro-1.5", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "google/gemini-flash-1.5", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "meta-llama/llama-3.3-70b-instruct", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "meta-llama/llama-3.1-405b-instruct", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek/deepseek-chat", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek/deepseek-r1", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "qwen/qwen-2.5-72b-instruct", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen/qwen-2.5-coder-32b-instruct", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "mistralai/mistral-large", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "x-ai/grok-2-1212", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "free/deepseek-r1", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "free/llama-3.3-70b", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "free/qwen-2.5-coder-32b", object: "model", owned_by: "openrouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const TOGETHER_MODELS: ProviderStaticModels[] = [
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", object: "model", owned_by: "together", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", object: "model", owned_by: "together", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", object: "model", owned_by: "together", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", object: "model", owned_by: "together", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "Qwen/Qwen2.5-Coder-32B-Instruct", object: "model", owned_by: "together", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-V3", object: "model", owned_by: "together", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-R1", object: "model", owned_by: "together", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
];

const CEREBRAS_MODELS: ProviderStaticModels[] = [
  { id: "llama-3.3-70b", object: "model", owned_by: "cerebras", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "llama3.1-8b", object: "model", owned_by: "cerebras", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen-2.5-coder-32b", object: "model", owned_by: "cerebras", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-r1-distill-llama-70b", object: "model", owned_by: "cerebras", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "deepseek-r1-distill-qwen-32b", object: "model", owned_by: "cerebras", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
];

const FIREWORKS_MODELS: ProviderStaticModels[] = [
  { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", object: "model", owned_by: "fireworks", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "accounts/fireworks/models/qwen2p5-coder-32b-instruct", object: "model", owned_by: "fireworks", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "accounts/fireworks/models/deepseek-v3", object: "model", owned_by: "fireworks", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "accounts/fireworks/models/deepseek-r1", object: "model", owned_by: "fireworks", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
];

const XAI_MODELS: ProviderStaticModels[] = [
  { id: "grok-2-1212", object: "model", owned_by: "xai", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "grok-2-vision-1212", object: "model", owned_by: "xai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "grok-beta", object: "model", owned_by: "xai", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "grok-vision-beta", object: "model", owned_by: "xai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
];

const MISTRAL_MODELS: ProviderStaticModels[] = [
  { id: "mistral-large-latest", object: "model", owned_by: "mistral", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "mistral-small-latest", object: "model", owned_by: "mistral", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "codestral-latest", object: "model", owned_by: "mistral", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "open-mixtral-8x7b", object: "model", owned_by: "mistral", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "open-mistral-7b", object: "model", owned_by: "mistral", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "open-mistral-nemo", object: "model", owned_by: "mistral", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const OPENAI_MODELS: ProviderStaticModels[] = [
  { id: "gpt-4o", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gpt-4o-mini", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gpt-4-turbo", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gpt-4", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "gpt-3.5-turbo", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "o1", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "o1-mini", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "o1-preview", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "o3-mini", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
];

const GEMINI_MODELS: ProviderStaticModels[] = [
  { id: "gemini-1.5-pro", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gemini-1.5-flash", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gemini-1.5-flash-8b", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gemini-2.0-flash", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gemini-2.0-flash-thinking-exp", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
];

const COHERE_MODELS: ProviderStaticModels[] = [
  { id: "command-r-plus", object: "model", owned_by: "cohere", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "command-r", object: "model", owned_by: "cohere", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "command-r7b-12-2024", object: "model", owned_by: "cohere", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const PERPLEXITY_MODELS: ProviderStaticModels[] = [
  { id: "sonar-pro", object: "model", owned_by: "perplexity", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "sonar-reasoning-pro", object: "model", owned_by: "perplexity", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "sonar-reasoning", object: "model", owned_by: "perplexity", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "sonar", object: "model", owned_by: "perplexity", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
];

const SILICONFLOW_MODELS: ProviderStaticModels[] = [
  { id: "deepseek-ai/DeepSeek-V3", object: "model", owned_by: "siliconflow", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-R1", object: "model", owned_by: "siliconflow", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "Qwen/Qwen2.5-72B-Instruct", object: "model", owned_by: "siliconflow", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "Qwen/Qwen2.5-Coder-32B-Instruct", object: "model", owned_by: "siliconflow", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const NEBIUS_MODELS: ProviderStaticModels[] = [
  { id: "meta-llama/Meta-Llama-3.1-405B-Instruct", object: "model", owned_by: "nebius", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "meta-llama/Llama-3.3-70B-Instruct", object: "model", owned_by: "nebius", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "Qwen/Qwen2.5-32B-Instruct", object: "model", owned_by: "nebius", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-R1", object: "model", owned_by: "nebius", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
];

const HYPERBOLIC_MODELS: ProviderStaticModels[] = [
  { id: "meta-llama/Meta-Llama-3.1-405B-Instruct", object: "model", owned_by: "hyperbolic", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "Qwen/Qwen2.5-72B-Instruct", object: "model", owned_by: "hyperbolic", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-V3", object: "model", owned_by: "hyperbolic", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const CHUTES_MODELS: ProviderStaticModels[] = [
  { id: "deepseek-ai/DeepSeek-V3", object: "model", owned_by: "chutes", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-R1", object: "model", owned_by: "chutes", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "Qwen/Qwen2.5-Coder-32B-Instruct", object: "model", owned_by: "chutes", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

// ── Free-tier providers (require a free signup key) ──────────────────────────

const BLUESMINDS_MODELS: ProviderStaticModels[] = [
  { id: "meta-llama/Llama-3.3-70B-Instruct", object: "model", owned_by: "bluesminds", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "Qwen/Qwen2.5-72B-Instruct", object: "model", owned_by: "bluesminds", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-ai/DeepSeek-V3", object: "model", owned_by: "bluesminds", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const GOROUTER_MODELS: ProviderStaticModels[] = [
  { id: "gpt-4o", object: "model", owned_by: "gorouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gpt-4o-mini", object: "model", owned_by: "gorouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "claude-3.5-sonnet", object: "model", owned_by: "gorouter", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "deepseek-chat", object: "model", owned_by: "gorouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "llama-3.3-70b", object: "model", owned_by: "gorouter", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const SEEKAI_MODELS: ProviderStaticModels[] = [
  { id: "deepseek-chat", object: "model", owned_by: "seekai", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-r1", object: "model", owned_by: "seekai", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "llama-3.3-70b", object: "model", owned_by: "seekai", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

// ── 9Router-ported providers ─────────────────────────────────────────────────
// Model lists mirror 9Router's registries (open-sse/providers/registry/*.js);
// opencode additionally discovers models live at runtime.

const OPENCODE_MODELS: ProviderStaticModels[] = [
  // Free-tier models (no key) first — live /zen/v1/models overrides this list.
  { id: "deepseek-v4-flash-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "muse-spark-1.3-contributor-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "muse-spark-1.2-contributor-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "mimo-v2.5-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "nemotron-3-ultra-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "nemotron-3.5-lightning-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "ling-3.0-flash-fin-free", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "glm-5.3", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k3", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-v4-pro", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "gpt-5.5", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "claude-sonnet-4-5", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "gemini-3.5-flash", object: "model", owned_by: "opencode", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
];

const LLM7_MODELS: ProviderStaticModels[] = [
  { id: "gpt-5.5", object: "model", owned_by: "llm7", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "claude-opus-5", object: "model", owned_by: "llm7", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-v4-flash", object: "model", owned_by: "llm7", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "grok-4.5", object: "model", owned_by: "llm7", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k3", object: "model", owned_by: "llm7", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const KILO_GATEWAY_MODELS: ProviderStaticModels[] = [
  { id: "kilo-auto/free", object: "model", owned_by: "kilo-gateway", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", object: "model", owned_by: "kilo-gateway", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", object: "model", owned_by: "kilo-gateway", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
  { id: "kwaipilot/kat-coder-pro-v2.5:free", object: "model", owned_by: "kilo-gateway", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kilo-auto/frontier", object: "model", owned_by: "kilo-gateway", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "kilo-auto/balanced", object: "model", owned_by: "kilo-gateway", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const KIMCHI_MODELS: ProviderStaticModels[] = [
  { id: "minimax-m3", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k2.7", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k2.6", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k2.5", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "nemotron-3-ultra-fp4", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "minimax-m2.7", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "claude-opus-4-6", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
  { id: "claude-sonnet-4-6", object: "model", owned_by: "kimchi", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
];

const GLM_CN_MODELS: ProviderStaticModels[] = [
  { id: "glm-5.3", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
  { id: "glm-5.3-flash", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5.2", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5.1", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5-turbo", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
  { id: "glm-4.7", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-4.6v", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "glm-4.6", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-4.5-air", object: "model", owned_by: "glm-cn", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
];

const OPENCODE_GO_MODELS: ProviderStaticModels[] = [
  { id: "deepseek-flash", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5.3-flash", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
  { id: "glm-5.3", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5.2", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "glm-5.1", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k2.7-code", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k2.6", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "kimi-k3", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-v4-pro", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "deepseek-v4-flash", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "deepseek-v4-flash-vision-exp", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
  { id: "longcat-2.0", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "mimo-v2.5", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "mimo-v2.5-pro", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "minimax-m3", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "minimax-m2.7", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "minimax-m2.5", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen3.8-max", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen3.8-flash", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen3.7-max", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen3.7-plus", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "qwen3.6-plus", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: true, vision: false, reasoning: false } },
  { id: "hy4-preview", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
  { id: "hy3", object: "model", owned_by: "opencode-go", capabilities: { streaming: true, tools: false, vision: false, reasoning: false } },
];

const GEMINI_WEB_MODELS: ProviderStaticModels[] = [
  { id: "gemini-2.5-pro", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: true } },
  { id: "gemini-2.5-flash", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: true } },
  { id: "gemini-2.0-flash", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
  { id: "gemini-2.0-flash-thinking", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: true } },
  { id: "gemini-1.5-pro", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
  { id: "gemini-1.5-flash", object: "model", owned_by: "gemini", capabilities: { streaming: true, tools: false, vision: true, reasoning: false } },
];

// ── Catalog ────────────────────────────────────────────────────────────────────

export const PROVIDER_CATALOG: ProviderDefinition[] = [
  // ── Scraped (no API key required — uses browser bearer token) ────────────
  {
    id: "deepseek",
    name: "DeepSeek (Scraper)",
    category: "api_key",
    protocol: "scrape",
    baseUrl: "https://chat.deepseek.com",
    alias: "ds",
    webUrl: "https://deepseek.com",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "DeepSeek bearer token missing — see docs",
  },

  // ── OAuth providers (Claude Code, Codex, Antigravity, Gemini CLI) ────────
  {
    id: "claude",
    name: "Claude (Anthropic OAuth)",
    category: "oauth",
    protocol: "openai",
    baseUrl: "https://api.anthropic.com/v1",
    webUrl: "https://claude.ai",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Connect via OAuth at /admin (Claude Code subscription)",
    models: [
      { id: "claude-3-5-sonnet-20241022", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "claude-3-5-haiku-20241022", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "claude-3-opus-20240229", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "claude-3-7-sonnet-20250219", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "claude-sonnet-4-20250514", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "claude-opus-4-20250514", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
    ],
  },
  {
    id: "codex",
    name: "Codex (OpenAI OAuth)",
    category: "oauth",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    webUrl: "https://chat.openai.com",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Connect via OAuth at /admin (ChatGPT Plus / Pro)",
    models: [
      { id: "gpt-4o", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "gpt-4o-mini", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "o1", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: false, vision: false, reasoning: true } },
      { id: "o3", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
      { id: "o3-mini", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
      { id: "o4-mini", object: "model", owned_by: "openai", capabilities: { streaming: true, tools: true, vision: false, reasoning: true } },
    ],
  },
  {
    id: "antigravity",
    name: "Antigravity (Google OAuth)",
    category: "oauth",
    protocol: "openai",
    baseUrl: "https://cloudcode-pa.googleapis.com/v1beta",
    webUrl: "https://antigravity.google.com",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Connect via OAuth at /admin (Google Antigravity IDE)",
    models: [
      { id: "gemini-2.5-pro", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "gemini-2.5-flash", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "gemini-2.0-flash", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "claude-sonnet-4-20250514", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "claude-3-5-sonnet-20241022", object: "model", owned_by: "anthropic", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI (Google OAuth)",
    category: "oauth",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    webUrl: "https://gemini.google.com",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Connect via OAuth at /admin (Gemini CLI)",
    models: [
      { id: "gemini-2.0-flash", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: false } },
      { id: "gemini-2.5-pro", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "gemini-2.5-flash", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
      { id: "gemini-2.0-flash-thinking-exp", object: "model", owned_by: "google", capabilities: { streaming: true, tools: true, vision: true, reasoning: true } },
    ],
  },

  // ── Free-tier (free signup required) ──────────────────────────────────────
  {
    id: "bluesminds",
    name: "BluesMinds",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://api.bluesminds.com/v1",
    webUrl: "https://api.bluesminds.com/sign-up",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "BluesMinds API key missing",
    models: BLUESMINDS_MODELS,
  },
  {
    id: "gorouter",
    name: "GoRouter",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://gorouter.app/v1",
    webUrl: "https://gorouter.app/sign-up",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "GoRouter API key missing",
    models: GOROUTER_MODELS,
  },
  {
    id: "seekai",
    name: "SeekAI",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://seekai.cc/v1",
    webUrl: "https://seekai.cc/sign-up",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "SeekAI API key missing",
    models: SEEKAI_MODELS,
  },

  // ── Ported from 9Router (free & cheap unlimited-tier gateways) ───────────
  {
    id: "opencode",
    name: "OpenCode (Free)",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://opencode.ai",
    alias: "oc",
    webUrl: "https://opencode.ai/auth",
    requiresApiKey: false,
    supportsCustomUrl: false,
    statusMessage: "Free — no key needed (enable it). Optional opencode.ai key unlocks premium models",
    models: OPENCODE_MODELS,
  },
  {
    id: "llm7",
    name: "LLM7 (free token)",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://api.llm7.io/v1",
    webUrl: "https://llm7.io",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "LLM7 token missing — free at llm7.io",
    models: LLM7_MODELS,
  },
  {
    id: "kilo-gateway",
    name: "Kilo Gateway (free tier)",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://api.kilo.ai/api/gateway",
    alias: "kgw",
    webUrl: "https://kilo.ai/dashboard?tab=apiKeys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Kilo API key missing — free at kilo.ai dashboard",
    models: KILO_GATEWAY_MODELS,
  },
  {
    id: "kimchi",
    name: "Kimchi (free tier)",
    category: "free_tier",
    protocol: "openai",
    baseUrl: "https://llm.kimchi.dev/openai/v1",
    webUrl: "https://llm.kimchi.dev",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Kimchi API key missing",
    models: KIMCHI_MODELS,
  },
  {
    id: "glm-cn",
    name: "GLM (Zhipu, coding plan)",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    webUrl: "https://open.bigmodel.cn",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "GLM API key missing",
    models: GLM_CN_MODELS,
  },
  {
    id: "opencode-go",
    name: "OpenCode Go ($5/mo)",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://opencode.ai/zen/go/v1",
    alias: "ocg",
    webUrl: "https://opencode.ai/auth",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "OpenCode Go key missing — subscribe at opencode.ai/auth",
    models: OPENCODE_GO_MODELS,
  },
  {
    id: "gemini-web",
    name: "Gemini (Web Scraper)",
    category: "free_tier",
    protocol: "scrape",
    baseUrl: "https://gemini.google.com",
    alias: "gw",
    webUrl: "https://gemini.google.com",
    requiresApiKey: false,
    supportsCustomUrl: false,
    statusMessage: "Free — no key needed (cookie auto-fetched). Optional: paste base64 session to continue conversation",
    models: GEMINI_WEB_MODELS,
  },

  // ── Standard API-key providers ────────────────────────────────────────────
  {
    id: "openai",
    name: "OpenAI",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    webUrl: "https://platform.openai.com/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "OpenAI API key missing",
    models: OPENAI_MODELS,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.anthropic.com/v1",
    webUrl: "https://console.anthropic.com/settings/keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Anthropic API key missing",
    models: [],
  },
  {
    id: "groq",
    name: "Groq",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    webUrl: "https://console.groq.com/keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Groq API key missing",
    models: GROQ_MODELS,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    webUrl: "https://deepseek.com",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "DeepSeek API key missing",
    models: [],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    webUrl: "https://fireworks.ai/account/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Fireworks API key missing",
    models: FIREWORKS_MODELS,
  },
  {
    id: "together",
    name: "Together AI",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    webUrl: "https://api.together.xyz/settings/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Together API key missing",
    models: TOGETHER_MODELS,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.perplexity.ai",
    webUrl: "https://docs.perplexity.ai/guides/getting-started",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Perplexity API key missing",
    models: PERPLEXITY_MODELS,
  },
  {
    id: "cohere",
    name: "Cohere",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.cohere.ai/v1",
    webUrl: "https://dashboard.cohere.com/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Cohere API key missing",
    models: COHERE_MODELS,
  },
  {
    id: "huggingface",
    name: "HuggingFace",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api-inference.huggingface.co/v1",
    webUrl: "https://huggingface.co/settings/tokens",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "HuggingFace token missing",
    models: [],
  },
  {
    id: "replicate",
    name: "Replicate",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.replicate.com/v1",
    webUrl: "https://replicate.com/accounts/api-tokens",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Replicate API token missing",
    models: [],
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    category: "api_key",
    protocol: "openai",
    baseUrl: "",
    webUrl: "https://portal.azure.com/",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "Azure endpoint & key missing",
    models: [],
  },
  {
    id: "vertex",
    name: "Vertex AI (Google)",
    category: "api_key",
    protocol: "openai",
    baseUrl: "",
    webUrl: "https://console.cloud.google.com/",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "Vertex AI credentials missing",
    models: [],
  },
  {
    id: "vercel",
    name: "Vercel AI SDK",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.vercel.ai/v1",
    webUrl: "https://vercel.com/dashboard",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "Vercel AI key missing",
    models: [],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    webUrl: "https://openrouter.ai/keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "OpenRouter API key missing",
    models: OPENROUTER_MODELS,
  },
  {
    id: "ai21",
    name: "AI21 Labs",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.ai21.com/studio/v1",
    webUrl: "https://platform.ai21.com/user/settings/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "AI21 API key missing",
    models: [],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    webUrl: "https://console.mistral.ai/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Mistral API key missing",
    models: MISTRAL_MODELS,
  },
  {
    id: "octoml",
    name: "OctoML",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://llm.api.octoml.ai/v1",
    webUrl: "https://app.octoml.ai/",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "OctoML API key missing",
    models: [],
  },
  {
    id: "anyscale",
    name: "Anyscale",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.endpoints.anyscale.com/v1",
    webUrl: "https://app.anyscale.com/settings/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Anyscale API key missing",
    models: [],
  },
  {
    id: "runpod",
    name: "RunPod",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.runpod.ai/v2",
    webUrl: "https://www.runpod.io/console",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "RunPod API key missing",
    models: [],
  },
  {
    id: "modal",
    name: "Modal",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.modal.run/v1",
    webUrl: "https://modal.com/",
    requiresApiKey: true,
    supportsCustomUrl: true,
    statusMessage: "Modal API key missing",
    models: [],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    webUrl: "https://aistudio.google.com/apikey",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Gemini API key missing",
    models: GEMINI_MODELS,
  },
  {
    id: "cohere",
    name: "Cohere",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.cohere.ai/v1",
    webUrl: "https://dashboard.cohere.com/api-keys",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Cohere API key missing",
    models: COHERE_MODELS,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.perplexity.ai",
    webUrl: "https://docs.perplexity.ai/guides/getting-started",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Perplexity API key missing",
    models: PERPLEXITY_MODELS,
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    webUrl: "https://cloud.siliconflow.cn",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "SiliconFlow API key missing",
    models: SILICONFLOW_MODELS,
  },
  {
    id: "nebius",
    name: "Nebius",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.studio.nebius.ai/v1",
    webUrl: "https://studio.nebius.ai",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Nebius API key missing",
    models: NEBIUS_MODELS,
  },
  {
    id: "hyperbolic",
    name: "Hyperbolic",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    webUrl: "https://app.hyperbolic.xyz",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Hyperbolic API key missing",
    models: HYPERBOLIC_MODELS,
  },
  {
    id: "chutes",
    name: "Chutes AI",
    category: "api_key",
    protocol: "openai",
    baseUrl: "https://api.chutes.ai/v1",
    webUrl: "https://chutes.ai",
    requiresApiKey: true,
    supportsCustomUrl: false,
    statusMessage: "Chutes API key missing",
    models: CHUTES_MODELS,
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    category: "self_hosted",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    webUrl: "https://ollama.com",
    requiresApiKey: false,
    supportsCustomUrl: true,
    statusMessage: "Ollama not reachable at configured URL",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    category: "self_hosted",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    webUrl: "https://lmstudio.ai",
    requiresApiKey: false,
    supportsCustomUrl: true,
    statusMessage: "LM Studio not reachable at configured URL",
  },
];

// ── Custom providers (user-defined, loaded from config.json) ──────────────────

/**
 * Convert a user-defined CustomProviderDefinition (stored in config.json) into
 * a ProviderDefinition that the rest of the gateway can treat as built-in.
 */
function customDefToProviderDef(c: CustomProviderDefinition): ProviderDefinition {
  const requiresApiKey = c.authScheme !== "none";
  const buildHeaders = (base: Record<string, string>): Record<string, string> => {
    if (c.authScheme === "none") return base;
    // The actual key is injected at runtime by the executor from the stored
    // credential; here we only set up the header skeleton so the
    // OpenAIExecutor knows which header to populate.
    return base;
  };
  return {
    id: c.id,
    name: c.name,
    category: "api_key",
    protocol: "openai",
    baseUrl: c.baseUrl,
    requiresApiKey,
    supportsCustomUrl: false,
    statusMessage: requiresApiKey ? `${c.name} API key missing` : undefined,
    models: (c.models ?? []).map((m) => ({
      id: m.id,
      object: "model" as const,
      owned_by: c.id,
      capabilities: m.capabilities as ProviderStaticModels["capabilities"],
    })),
    buildHeaders,
    // Custom providers carry auth metadata in a side channel — the executor
    // builder reads it back from the CustomProviderDefinition at construction.
    // (We piggy-back on the alias field to mark custom providers.)
    alias: undefined,
  };
}

/** Return provider definitions for every user-defined custom provider. */
export function listCustomProviderDefs(): ProviderDefinition[] {
  try {
    return store.listCustomProviders().map(customDefToProviderDef);
  } catch {
    return [];
  }
}

/** All known provider definitions: built-in catalog + user-defined customs. */
export function allProviderDefs(): ProviderDefinition[] {
  return [...PROVIDER_CATALOG, ...listCustomProviderDefs()];
}

/** Auth metadata for a custom provider (used by the executor builder). */
export function getCustomProviderAuth(id: string): CustomProviderDefinition | undefined {
  return store.findCustomProvider(id);
}

// ── Builder ────────────────────────────────────────────────────────────────────

export interface ProviderInstance {
  definition: ProviderDefinition;
  apiKey: string;
  baseUrl: string;
}

/** Build an executor instance from a provider definition + runtime credential. */
export function buildExecutor(
  def: ProviderDefinition,
  apiKey: string,
  baseUrlOverride?: string
): unknown {
  const baseUrl = (baseUrlOverride ?? def.baseUrl).replace(/\/$/, "");
  if (def.protocol === "scrape") {
    if (def.id === "deepseek") {
      return new DeepSeekScraperExecutor({
        id: def.id,
        name: def.name,
        baseUrl,
        token: apiKey,
      });
    }
    // Gemini Web Scraper: cookie-based auth with session persistence.
    if (def.id === "gemini-web") {
      const models = def.models?.map((m) => ({
        id: `${def.alias ?? def.id}/${m.id}`,
        object: "model" as const,
        owned_by: def.alias ?? def.id,
        capabilities: m.capabilities,
      }));
      return new GeminiScraperExecutor({
        id: def.id,
        name: def.name,
        baseUrl,
        token: apiKey, // base64-encoded session string for continuity
        models,
      });
    }
    throw new Error(`Unknown scrape provider: ${def.id}`);
  }
  // OpenCode: bespoke executor (Bearer public free tier + Responses-API models).
  if (def.id === "opencode") {
    return new OpenCodeExecutor({
      id: def.id,
      name: def.name,
      baseUrl,
      apiKey,
      models: def.models?.map((m) => ({
        id: `${def.alias ?? def.id}/${m.id}`,
        object: "model" as const,
        owned_by: def.alias ?? def.id,
        capabilities: m.capabilities,
      })),
    });
  }
  // Anthropic executor
  if (def.id === "anthropic") {
    const models = def.models?.map((m) => ({
      id: `${def.alias ?? def.id}/${m.id}`,
      object: "model" as const,
      owned_by: def.alias ?? def.id,
      capabilities: m.capabilities,
    }));
    return new AnthropicExecutor({
      id: def.id,
      name: def.name,
      baseUrl,
      apiKey,
      models,
    });
  }
  // Groq executor
  if (def.id === "groq") {
    const models = def.models?.map((m) => ({
      id: `${def.alias ?? def.id}/${m.id}`,
      object: "model" as const,
      owned_by: def.alias ?? def.id,
      capabilities: m.capabilities,
    }));
    return new GroqExecutor({
      id: def.id,
      name: def.name,
      baseUrl,
      apiKey,
      models,
    });
  }
  // DeepSeek executor
  if (def.id === "deepseek") {
    return new DeepSeekExecutor({
      id: def.id,
      name: def.name,
      baseUrl,
      apiKey,
    });
  }
  // Fireworks executor
  if (def.id === "fireworks") {
    const models = def.models?.map((m) => ({
      id: `${def.alias ?? def.id}/${m.id}`,
      object: "model" as const,
      owned_by: def.alias ?? def.id,
      capabilities: m.capabilities,
    }));
    return new FireworksExecutor({
      id: def.id,
      name: def.name,
      baseUrl,
      apiKey,
      models,
    });
  }
  // Default: OpenAI-compatible
  const models = def.models?.map((m) => ({
    id: `${def.alias ?? def.id}/${m.id}`,
    object: "model" as const,
    owned_by: def.alias ?? def.id,
    capabilities: m.capabilities,
  }));
  // Custom providers may declare a non-Bearer auth scheme — pull the metadata
  // from the config store and pass it down to the OpenAIExecutor.
  const customAuth = getCustomProviderAuth(def.id);
  const buildHeaders = customAuth
    ? (base: Record<string, string>): Record<string, string> => {
        if (customAuth.authScheme === "none") {
          delete base["Authorization"];
          return base;
        }
        if (customAuth.authScheme === "x-api-key") {
          // Move the Bearer token to x-api-key
          const token = base["Authorization"]?.startsWith("Bearer ")
            ? base["Authorization"].slice(7)
            : (customAuth as unknown as { apiKey?: string }).apiKey ?? "";
          delete base["Authorization"];
          base["x-api-key"] = token;
          return base;
        }
        if (customAuth.authScheme === "custom-header" && customAuth.authHeaderName) {
          const token = base["Authorization"]?.startsWith("Bearer ")
            ? base["Authorization"].slice(7)
            : (customAuth as unknown as { apiKey?: string }).apiKey ?? "";
          delete base["Authorization"];
          const prefix = customAuth.authHeaderPrefix ?? "";
          base[customAuth.authHeaderName] = prefix ? `${prefix} ${token}`.trim() : token;
          return base;
        }
        return base;
      }
    : undefined;
  return new OpenAIExecutor({
    id: def.id,
    name: def.name,
    baseUrl,
    apiKey,
    models,
    stripProviderPrefix: true,
    buildHeaders,
  });
}

/** Find a provider definition by id or alias (e.g. "ds" → deepseek). */
export function findProviderDef(idOrAlias: string): ProviderDefinition | undefined {
  const lower = idOrAlias.toLowerCase();
  return allProviderDefs().find(
    (p) =>
      p.id.toLowerCase() === lower || p.alias?.toLowerCase() === lower
  );
}
