/**
 * Smart Router — auto-pick the best model for a request based on configurable
 * strategy: cheapest, fastest, highest-quality, or balanced.
 *
 * Usage: send `model: "smart/cheapest"` (or `smart/fastest`, `smart/balanced`)
 * and the router will resolve it to the cheapest/fastest/best enabled model
 * that supports the request's requirements (tools, vision, etc.).
 *
 * Routing decisions are logged so the dashboard can show which model was
 * actually picked.
 */

import { listAllModels } from "./registry";
import { getPricing } from "./pricing";
import { getSetting, setSetting } from "./db";
import type { ChatCompletionRequest } from "../types";

export type SmartStrategy = "cheapest" | "fastest" | "balanced" | "highest-quality";

export interface SmartRouterSettings {
  enabled: boolean;
  defaultStrategy: SmartStrategy;
  /** Models to exclude from smart routing (blocklist). */
  excludedModels: string[];
  /** Prefer models from these providers (whitelist, empty = all). */
  preferredProviders: string[];
}

const DEFAULT_SETTINGS: SmartRouterSettings = {
  enabled: true,
  defaultStrategy: "balanced",
  excludedModels: [],
  preferredProviders: [],
};

let settingsCache: SmartRouterSettings | null = null;

export function getSmartRouterSettings(): SmartRouterSettings {
  if (settingsCache) return settingsCache;
  try {
    const raw = getSetting("smart_router_settings", JSON.stringify(DEFAULT_SETTINGS));
    const parsed = JSON.parse(raw) as Partial<SmartRouterSettings>;
    settingsCache = {
      enabled: parsed.enabled ?? DEFAULT_SETTINGS.enabled,
      defaultStrategy: parsed.defaultStrategy ?? DEFAULT_SETTINGS.defaultStrategy,
      excludedModels: parsed.excludedModels ?? [],
      preferredProviders: parsed.preferredProviders ?? [],
    };
    return settingsCache;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSmartRouterSettings(s: Partial<SmartRouterSettings>): SmartRouterSettings {
  const current = getSmartRouterSettings();
  settingsCache = {
    enabled: s.enabled ?? current.enabled,
    defaultStrategy: s.defaultStrategy ?? current.defaultStrategy,
    excludedModels: s.excludedModels ?? current.excludedModels,
    preferredProviders: s.preferredProviders ?? current.preferredProviders,
  };
  setSetting("smart_router_settings", JSON.stringify(settingsCache));
  return settingsCache;
}

/** Detect if a model id is a smart-router request: "smart/<strategy>". */
export function isSmartRouteRequest(model: string): boolean {
  return model.startsWith("smart/");
}

/** Parse the strategy from a "smart/<strategy>" model id. */
export function parseStrategy(model: string): SmartStrategy {
  const strategy = model.slice("smart/".length).toLowerCase();
  if (strategy === "cheapest" || strategy === "fastest" || strategy === "balanced" || strategy === "highest-quality") {
    return strategy;
  }
  return getSmartRouterSettings().defaultStrategy;
}

interface ModelCapability {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

/**
 * Resolve a "smart/<strategy>" model id to a concrete `provider/model` id
 * based on the request's requirements and the configured strategy.
 *
 * Returns null if no eligible model is found.
 */
export async function resolveSmartModel(
  smartModel: string,
  req: ChatCompletionRequest
): Promise<string | null> {
  const settings = getSmartRouterSettings();
  if (!settings.enabled) return null;

  const strategy = parseStrategy(smartModel);
  const needsTools = Array.isArray(req.tools) && req.tools.length > 0;
  const needsVision = JSON.stringify(req.messages).includes('"image_url"');
  const needsReasoning = (req as { reasoning_effort?: string }).reasoning_effort !== undefined;

  // Get all available models from enabled providers
  const allModels = await listAllModels();

  // Filter by requirements
  const eligible = allModels.filter((m) => {
    if (settings.excludedModels.includes(m.id)) return false;
    if (settings.preferredProviders.length > 0) {
      const provider = m.id.split("/")[0];
      if (!settings.preferredProviders.includes(provider!)) return false;
    }
    const caps = (m.capabilities ?? {}) as ModelCapability;
    if (needsTools && caps.tools === false) return false;
    if (needsVision && caps.vision === false) return false;
    if (needsReasoning && caps.reasoning === false) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  // Score each model based on strategy
  const scored = eligible.map((m) => {
    const pricing = getPricing(m.id);
    const caps = (m.capabilities ?? {}) as ModelCapability;
    let score = 0;
    switch (strategy) {
      case "cheapest":
        // Lower cost = higher score
        score = -(pricing.input + pricing.output);
        break;
      case "fastest":
        // Prefer smaller models (heuristic: models with "mini"/"flash"/"haiku"/"8b" are faster)
        const fastKeywords = ["mini", "flash", "haiku", "8b", "instant", "lite", "nano"];
        score = fastKeywords.some((k) => m.id.toLowerCase().includes(k)) ? 100 : 0;
        // Penalize expensive models (proxy for size)
        score -= (pricing.input + pricing.output) * 0.1;
        break;
      case "highest-quality":
        // Prefer models with reasoning capability, then expensive (=large) models
        score = (caps.reasoning ? 50 : 0) + (caps.tools ? 10 : 0) + (caps.vision ? 5 : 0);
        score += (pricing.input + pricing.output) * 0.5; // expensive ≈ large ≈ better
        break;
      case "balanced":
      default:
        // Balance cost and capability
        score = (caps.tools ? 20 : 0) + (caps.vision ? 10 : 0) + (caps.streaming ? 5 : 0);
        score -= (pricing.input + pricing.output) * 0.3;
        break;
    }
    return { model: m, score };
  });

  // Sort by score descending, pick the top
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.model.id ?? null;
}
