/**
 * Combos — named model aliases backed by ordered lists of `provider/model`
 * strings. When a request references a combo alias, the router tries each
 * model in order until one succeeds (fallback strategy) or rotates
 * (round-robin strategy).
 *
 * Combo definitions are stored in the config.json under `combos`:
 *
 *   { id: "fast-coder", strategy: "fallback", models: [
 *       "groq/llama-3.3-70b-versatile",
 *       "together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
 *       "deepseek/deepseek-chat"
 *     ]}
 *
 * Use a combo by setting `model` to `combo/<id>` in chat completions.
 */

import type { ChatCompletionRequest } from "../types";
import * as store from "./config-store";

export interface Combo {
  id: string;
  name: string;
  strategy: "fallback" | "round-robin";
  models: string[];
  /** Round-robin only: how many requests to send to each model before rotating */
  stickyLimit?: number;
}

// In-memory round-robin state per combo id
const rotationState = new Map<string, { index: number; consecutiveUseCount: number }>();

export function listCombos(): Combo[] {
  const cfg = store.loadConfig();
  return (cfg.combos ?? []).map((c) => ({ ...c }));
}

export function createCombo(combo: Omit<Combo, "id"> & { id?: string }): Combo {
  const cfg = store.loadConfig();
  // If user provided a name, use its slug as the id (so `combo/fast-chain` works)
  const id = combo.id ?? (combo.name ? slugify(combo.name) : `combo-${Date.now()}`);
  const final: Combo = {
    id,
    name: combo.name,
    strategy: combo.strategy,
    models: combo.models,
    stickyLimit: combo.stickyLimit ?? 1,
  };
  cfg.combos = [...(cfg.combos ?? []), final];
  store.saveConfig(cfg);
  return final;
}

export function deleteCombo(id: string): void {
  const cfg = store.loadConfig();
  cfg.combos = (cfg.combos ?? []).filter((c) => c.id !== id);
  store.saveConfig(cfg);
  rotationState.delete(id);
}

export function findCombo(idOrName: string): Combo | undefined {
  const lower = idOrName.toLowerCase();
  return listCombos().find(
    (c) => c.id === idOrName || c.id.toLowerCase() === lower || c.name.toLowerCase() === lower || slugify(c.name) === lower
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolve a `combo/<id>` model request into an ordered list of model candidates. */
export function resolveCombo(model: string): string[] | null {
  if (!model.startsWith("combo/")) return null;
  const comboId = model.slice("combo/".length);
  const combo = findCombo(comboId);
  if (!combo) return null;

  if (combo.strategy === "fallback") {
    return combo.models;
  }
  // Round-robin
  const state = rotationState.get(comboId) ?? { index: 0, consecutiveUseCount: 0 };
  const rotated = [
    ...combo.models.slice(state.index),
    ...combo.models.slice(0, state.index),
  ];
  state.consecutiveUseCount += 1;
  if (state.consecutiveUseCount >= (combo.stickyLimit ?? 1)) {
    state.index = (state.index + 1) % combo.models.length;
    state.consecutiveUseCount = 0;
  }
  rotationState.set(comboId, state);
  return rotated;
}
