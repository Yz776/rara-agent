/**
 * Disk-backed config store.
 *
 * Persists:
 *  - per-provider credentials (API keys / tokens / OAuth access+refresh)
 *  - per-provider baseUrl overrides
 *  - admin API keys (the keys AI agents use to authenticate against this gateway)
 *  - fallback rules (model A → model B on specific status codes)
 *
 * Storage format: a single JSON file at the path returned by configPath().
 * On boot the file is loaded into memory; every mutation is fsynced to disk.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataFile } from "./paths";

const DEFAULT_CONFIG_PATH = dataFile("config.json");

export interface AdminKey {
  id: string;
  key: string;
  name: string;
  createdAt: number;
}

export interface FallbackRule {
  id: string;
  sourceModel: string;
  targetModel: string;
  triggerStatus: number[];
  enabled: boolean;
}

export interface ProviderCredential {
  id: string;
  apiKey: string;
  baseUrl?: string;
  enabled: boolean;
  createdAt: number;
}

export interface VirtualKeyPermission {
  id: string;
  name: string;
  apiKey: string;
  enabled: boolean;
  roles: ("read" | "write" | "admin")[];
  allowedModels: string[]; // null = all models
  denyModels: string[];
  rateLimit: number; // req/min, 0 = unlimited
  quotaLimit: number; // lifetime tokens, 0 = unlimited
  creditLimit: number; // USD, 0 = unlimited
  usageTokens: number;
  usageCost: number;
  expiresAt?: number; // optional expiry timestamp
  createdAt: number;
}

export interface KRouterConfig {
  adminKeys: AdminKey[];
  virtualKeys: VirtualKeyPermission[];
  providers: ProviderCredential[];
  fallbacks: FallbackRule[];
  combos?: ComboEntry[];
  customProviders?: CustomProviderDefinition[];
}

export interface ComboEntry {
  id: string;
  name: string;
  strategy: "fallback" | "round-robin";
  models: string[];
  stickyLimit?: number;
}

/**
 * User-defined custom provider — same shape as ProviderDefinition in the
 * catalog, but persisted in config.json so it survives restarts.
 *
 * The user picks an id (used as the `provider/model` prefix), a base URL,
 * an auth scheme (Bearer, x-api-key, custom header, or none), and a list
 * of static models. The gateway then treats it like any built-in provider.
 */
export interface CustomProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  /** "bearer" | "x-api-key" | "custom-header" | "none" */
  authScheme: "bearer" | "x-api-key" | "custom-header" | "none";
  /** Name of the custom header (when authScheme === "custom-header") */
  authHeaderName?: string;
  /** Optional prefix added before the API key when sending the header */
  authHeaderPrefix?: string;
  /** Static list of model ids (without the provider prefix). */
  models: Array<{ id: string; capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean; reasoning?: boolean } }>;
  /** Whether the upstream /models endpoint can be trusted to list models live. */
  fetchModelsLive: boolean;
  createdAt: number;
}

export interface TokenSaverConfig {
  enabled: boolean;
  compressToolOutput: { enabled: boolean; minCharacterThreshold: number };
  lazySeniorDev: { enabled: boolean; mode: "balanced" | "strict" };
  compressLlmOutput: { enabled: boolean; mode: "terse" | "ultra_terse" };
  trimMessages: { enabled: boolean; maxInputTokens: number; preserveTailMessages: number };
}

function emptyConfig(): KRouterConfig {
  return { adminKeys: [], virtualKeys: [], providers: [], fallbacks: [], customProviders: [] };
}

function configPath(): string {
  return process.env.KROUTER_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

let cache: KRouterConfig | null = null;

function load(): KRouterConfig {
  if (cache) return cache;
  const p = configPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as KRouterConfig;
    cache = {
      adminKeys: parsed.adminKeys ?? [],
      virtualKeys: parsed.virtualKeys ?? [],
      providers: parsed.providers ?? [],
      fallbacks: parsed.fallbacks ?? [],
      combos: parsed.combos ?? [],
      customProviders: parsed.customProviders ?? [],
    };
  } catch {
    cache = emptyConfig();
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf8");
  try {
    fs.sync && fs.sync();
  } catch {
    /* fsync may not exist on all platforms; ignore */
  }
}

// ── Public config access (for combos module) ───────────────────────────────

export function loadConfig(): KRouterConfig {
  return load();
}

export function saveConfig(cfg: KRouterConfig): void {
  cache = cfg;
  persist();
}

// ── Virtual Keys with Permissions ──────────────────────────────────────────────

export function listVirtualKeys(): VirtualKeyPermission[] {
  return load().virtualKeys;
}

export function createVirtualKey(opts: Omit<VirtualKeyPermission, "id" | "apiKey" | "createdAt">): VirtualKeyPermission {
  const cfg = load();
  
  // Generate unique API key
  const apiKey = `kr-${crypto.randomBytes(20).toString("hex")}`;
  
  const key: VirtualKeyPermission = {
    id: crypto.randomUUID(),
    name: opts.name || `key-${cfg.virtualKeys.length + 1}`,
    apiKey,
    enabled: opts.enabled ?? true,
    roles: opts.roles ?? ["read"],
    allowedModels: opts.allowedModels ?? [], // empty = all models allowed by default
    denyModels: opts.denyModels ?? [],
    rateLimit: opts.rateLimit ?? 0,
    quotaLimit: opts.quotaLimit ?? 0,
    creditLimit: opts.creditLimit ?? 0,
    usageTokens: 0,
    usageCost: 0,
    expiresAt: opts.expiresAt,
    createdAt: Date.now(),
  };
  
  cfg.virtualKeys.push(key);
  persist();
  return key;
}

export function deleteVirtualKey(id: string): void {
  const cfg = load();
  cfg.virtualKeys = cfg.virtualKeys.filter((k) => k.id !== id);
  persist();
}

export function updateVirtualKeyUsage(id: string, tokens: number, cost: number): void {
  const cfg = load();
  const key = cfg.virtualKeys.find((k) => k.id === id);
  if (key) {
    key.usageTokens += tokens;
    key.usageCost += cost;
    persist();
  }
}

export function findVirtualKey(token: string): VirtualKeyPermission | undefined {
  if (!token) return undefined;
  const cleaned = token.startsWith("Bearer ") ? token.slice(7) : token;
  return load().virtualKeys.find((k) => k.apiKey === cleaned && k.enabled);
}

export function updateVirtualKey(id: string, updates: Partial<Omit<VirtualKeyPermission, "id" | "apiKey" | "createdAt">>): boolean {
  const cfg = load();
  const key = cfg.virtualKeys.find((k) => k.id === id);
  if (!key) return false;
  
  Object.assign(key, updates);
  persist();
  return true;
}

// ── Admin keys ────────────────────────────────────────────────────────────────

export function listAdminKeys(): AdminKey[] {
  return load().adminKeys;
}

export function createAdminKey(name: string): AdminKey {
  const cfg = load();
  const key: AdminKey = {
    id: crypto.randomUUID(),
    key: `kr-${crypto.randomBytes(24).toString("hex")}`,
    name: name || `key-${cfg.adminKeys.length + 1}`,
    createdAt: Date.now(),
  };
  cfg.adminKeys.push(key);
  persist();
  return key;
}

export function deleteAdminKey(id: string): void {
  const cfg = load();
  cfg.adminKeys = cfg.adminKeys.filter((k) => k.id !== id);
  persist();
}

export function findAdminKey(token: string): AdminKey | undefined {
  if (!token) return undefined;
  // Accept "Bearer <key>" or raw key
  const cleaned = token.startsWith("Bearer ") ? token.slice(7) : token;
  return load().adminKeys.find((k) => k.key === cleaned);
}

// ── Provider credentials ──────────────────────────────────────────────────────

export function listProviders(): ProviderCredential[] {
  return load().providers;
}

export function upsertProvider(cred: Partial<ProviderCredential> & { id: string }): ProviderCredential {
  const cfg = load();
  const existing = cfg.providers.find((p) => p.id === cred.id);
  const final: ProviderCredential = {
    id: cred.id,
    apiKey: cred.apiKey ?? existing?.apiKey ?? "",
    baseUrl: cred.baseUrl ?? existing?.baseUrl,
    enabled: cred.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  if (existing) {
    Object.assign(existing, final);
  } else {
    cfg.providers.push(final);
  }
  persist();
  return final;
}

export function deleteProvider(id: string): void {
  const cfg = load();
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  persist();
}

export function findProvider(id: string): ProviderCredential | undefined {
  return load().providers.find((p) => p.id === id);
}

// ── Fallback rules ─────────────────────────────────────────────────────────────

export function listFallbacks(): FallbackRule[] {
  return load().fallbacks;
}

export function createFallback(rule: Omit<FallbackRule, "id">): FallbackRule {
  const cfg = load();
  const fb: FallbackRule = { ...rule, id: crypto.randomUUID() };
  cfg.fallbacks.push(fb);
  persist();
  return fb;
}

export function deleteFallback(id: string): void {
  const cfg = load();
  cfg.fallbacks = cfg.fallbacks.filter((f) => f.id !== id);
  persist();
}

// ── Custom providers (user-defined) ──────────────────────────────────────────

export function listCustomProviders(): CustomProviderDefinition[] {
  return load().customProviders ?? [];
}

export function findCustomProvider(id: string): CustomProviderDefinition | undefined {
  return (load().customProviders ?? []).find((p) => p.id === id);
}

export function upsertCustomProvider(
  def: Omit<CustomProviderDefinition, "createdAt"> & { createdAt?: number }
): CustomProviderDefinition {
  const cfg = load();
  if (!cfg.customProviders) cfg.customProviders = [];
  const existingIdx = cfg.customProviders.findIndex((p) => p.id === def.id);
  const final: CustomProviderDefinition = {
    ...def,
    createdAt: def.createdAt ?? (existingIdx >= 0 ? cfg.customProviders[existingIdx]!.createdAt : Date.now()),
  };
  if (existingIdx >= 0) {
    cfg.customProviders[existingIdx] = final;
  } else {
    cfg.customProviders.push(final);
  }
  persist();
  return final;
}

export function deleteCustomProvider(id: string): void {
  const cfg = load();
  cfg.customProviders = (cfg.customProviders ?? []).filter((p) => p.id !== id);
  // Also drop any stored credential for this provider id
  cfg.providers = cfg.providers.filter((p) => p.id !== id);
  persist();
}
