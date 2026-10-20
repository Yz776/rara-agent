/**
 * Pricing database — per-model token costs (USD per 1M tokens).
 *
 * Used to compute the cost of every request so the dashboard can show:
 *   - per-key spend
 *   - per-model spend
 *   - daily/monthly cost trends
 *   - budget alerts (warning at 80%, critical at 95%)
 *
 * Pricing is sourced from each provider's public pricing page. Custom pricing
 * overrides are stored in the SQLite settings table under key "pricing_overrides"
 * (JSON: { "openai/gpt-4o": { input: 2.5, output: 10 } }).
 *
 * All prices are USD per 1,000,000 tokens. 0 = unknown/free.
 */

import { getSetting, setSetting } from "./db";

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens (if provider supports prompt caching) */
  cachedInput?: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "openai/gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "openai/gpt-4-turbo": { input: 10, output: 30 },
  "openai/gpt-4": { input: 30, output: 60 },
  "openai/gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "openai/o1": { input: 15, output: 60 },
  "openai/o1-mini": { input: 3, output: 12 },
  "openai/o1-preview": { input: 15, output: 60 },
  "openai/o3-mini": { input: 3, output: 12 },
  "openai/text-embedding-3-small": { input: 0.02, output: 0 },
  "openai/text-embedding-3-large": { input: 0.13, output: 0 },
  "openai/dall-e-3": { input: 0, output: 0 }, // per-image pricing not token-based

  // Anthropic
  "anthropic/claude-3-5-sonnet": { input: 3, output: 15, cachedInput: 0.3 },
  "anthropic/claude-3-5-haiku": { input: 0.8, output: 4 },
  "anthropic/claude-3-opus": { input: 15, output: 75 },
  "anthropic/claude-3-sonnet": { input: 3, output: 15 },
  "anthropic/claude-3-haiku": { input: 0.25, output: 1.25 },

  // Google Gemini
  "gemini/gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini/gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini/gemini-2.0-flash": { input: 0.1, output: 0.4 },

  // Groq (very cheap — open-source models on fast inference)
  "groq/llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "groq/llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "groq/mixtral-8x7b-32768": { input: 0.24, output: 0.24 },

  // OpenRouter (passthrough — varies, use approximate)
  "openrouter/openai/gpt-4o": { input: 2.5, output: 10 },
  "openrouter/anthropic/claude-3.5-sonnet": { input: 3, output: 15 },

  // Together
  "together/meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 0.88, output: 0.88 },

  // DeepSeek
  "deepseek/deepseek-chat": { input: 0.14, output: 0.28, cachedInput: 0.014 },
  "deepseek/deepseek-coder": { input: 0.14, output: 0.28 },

  // Mistral
  "mistral/mistral-large-latest": { input: 2, output: 6 },
  "mistral/mistral-small-latest": { input: 0.2, output: 0.6 },

  // Cohere
  "cohere/command-r-plus": { input: 2.5, output: 10 },
  "cohere/command-r": { input: 0.15, output: 0.6 },

  // Perplexity
  "perplexity/sonar-pro": { input: 3, output: 15 },
  "perplexity/sonar": { input: 1, output: 1 },

  // xAI
  "xai/grok-2-1212": { input: 2, output: 10 },

  // Fireworks
  "fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct": { input: 0.9, output: 0.9 },

  // SiliconFlow
  "siliconflow/deepseek-ai/DeepSeek-V3": { input: 1.39, output: 2.77 },
  "siliconflow/deepseek-ai/DeepSeek-R1": { input: 4.13, output: 4.13 },

  // Free-tier / scraped providers (no token cost — use 0)
  "opencode/big-pickle": { input: 0, output: 0 },
  "deepseek/deepseek-scraper": { input: 0, output: 0 },
  "ollama/mock-llama": { input: 0, output: 0 },
};

let overridesCache: Record<string, ModelPricing> | null = null;

function loadOverrides(): Record<string, ModelPricing> {
  if (overridesCache) return overridesCache;
  try {
    const raw = getSetting("pricing_overrides", "{}");
    overridesCache = JSON.parse(raw) as Record<string, ModelPricing>;
  } catch {
    overridesCache = {};
  }
  return overridesCache!;
}

/** Get pricing for a `provider/model` id (case-insensitive). */
export function getPricing(modelId: string): ModelPricing {
  const lower = modelId.toLowerCase();
  const overrides = loadOverrides();
  // Check exact override
  if (overrides[lower]) return overrides[lower]!;
  // Check default
  if (DEFAULT_PRICING[lower]) return DEFAULT_PRICING[lower]!;
  // Try provider-prefix match (e.g. "openai/gpt-4o-2024-08-06" → "openai/gpt-4o")
  for (const key of Object.keys(DEFAULT_PRICING)) {
    if (lower.startsWith(key)) return DEFAULT_PRICING[key]!;
  }
  // Unknown model — return zero so we don't lie about cost
  return { input: 0, output: 0 };
}

/** Set a custom pricing override (admin API). */
export function setPricingOverride(modelId: string, pricing: ModelPricing): void {
  const overrides = loadOverrides();
  overrides[modelId.toLowerCase()] = pricing;
  setSetting("pricing_overrides", JSON.stringify(overrides));
  // Update cache in place
  overridesCache = overrides;
}

/** Clear a single pricing override. */
export function clearPricingOverride(modelId: string): void {
  const overrides = loadOverrides();
  delete overrides[modelId.toLowerCase()];
  setSetting("pricing_overrides", JSON.stringify(overrides));
  overridesCache = overrides;
}

/** List all known pricing entries (defaults + overrides). */
export function listAllPricing(): Array<{ model: string; pricing: ModelPricing; isOverride: boolean }> {
  const overrides = loadOverrides();
  const seen = new Set<string>();
  const result: Array<{ model: string; pricing: ModelPricing; isOverride: boolean }> = [];
  // Overrides first
  for (const [model, pricing] of Object.entries(overrides)) {
    result.push({ model, pricing, isOverride: true });
    seen.add(model);
  }
  // Then defaults
  for (const [model, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (!seen.has(model)) {
      result.push({ model, pricing, isOverride: false });
    }
  }
  return result;
}

/**
 * Compute the cost (USD) of a request given the model + token counts.
 * Returns 0 if pricing is unknown (free tier, scraped, etc.).
 */
export function computeCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0
): number {
  const p = getPricing(modelId);
  if (!p.input && !p.output) return 0;
  const inputCost = (promptTokens / 1_000_000) * p.input;
  const outputCost = (completionTokens / 1_000_000) * p.output;
  const cachedCost = cachedTokens > 0 && p.cachedInput
    ? (cachedTokens / 1_000_000) * p.cachedInput
    : 0;
  // Subtract cached portion from regular input cost (it was already billed at cached rate)
  const adjustedInputCost = cachedTokens > 0
    ? ((promptTokens - cachedTokens) / 1_000_000) * p.input
    : inputCost;
  return Math.round((adjustedInputCost + outputCost + cachedCost) * 1_000_000) / 1_000_000;
}

/** Format USD cost as a human-readable string. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
