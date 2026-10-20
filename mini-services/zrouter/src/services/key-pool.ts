/**
 * Upstream API-key pool — manages multiple (provider, apiKey, optional
 * proxyUrl) tuples per provider and rotates them round-robin. On 429/403/503
 * or quota errors, the offending entry is put in cooldown (default 60s) and
 * the next healthy entry is returned on the next pick.
 *
 * Backed by the `key_pool` table in krouter.db. Pool entries are created /
 * managed via the admin UI (Pool tab) at /admin/api/pool.
 *
 * Public surface:
 *  - listEntries(providerId?)              : list all entries (optionally filtered)
 *  - createEntry(input)                    : insert new pool entry
 *  - updateEntry(id, patch)                : toggle enabled / edit label / etc.
 *  - deleteEntry(id)                       : remove
 *  - pickKey(providerId)                   : round-robin select; returns
 *                                            {entry, apiKey, baseUrl?, proxyUrl?}
 *                                            or null when pool has no healthy entry
 *  - markCooldown(id, ms, lastError?)     : set entry to 'cooldown' until now+ms
 *  - markSuccess(id)                      : reset fail_count, ensure status='active'
 *  - resetCooldown(id)                     : manually revive an entry (admin)
 *  - sweepExpiredCooldowns()              : revive entries past their cooldown
 *  - poolStats()                          : per-provider summary
 *  - entriesForProvider(providerId)       : count of enabled entries
 */

import crypto from "node:crypto";
import { getDb } from "./db";

export type PoolStatus = "active" | "cooldown" | "disabled";

export interface PoolEntry {
  id: string;
  label: string;
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  enabled: boolean;
  weight: number;
  status: PoolStatus;
  cooldownUntil?: number;
  lastUsedAt?: number;
  lastFailedAt?: number;
  failCount: number;
  usageCount: number;
  lastError?: string;
  createdAt: number;
}

export interface PickedKey {
  entry: PoolEntry;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  poolEntryId: string;
}

export interface CreatePoolEntryInput {
  label: string;
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  enabled?: boolean;
  weight?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

function mapRow(r: Record<string, unknown> | undefined): PoolEntry | undefined {
  if (!r) return undefined;
  return {
    id: r.id as string,
    label: r.label as string,
    providerId: r.provider_id as string,
    apiKey: r.api_key as string,
    baseUrl: (r.base_url as string) || undefined,
    proxyUrl: (r.proxy_url as string) || undefined,
    enabled: Boolean(r.enabled),
    weight: r.weight as number,
    status: r.status as PoolStatus,
    cooldownUntil: (r.cooldown_until as number) || undefined,
    lastUsedAt: (r.last_used_at as number) || undefined,
    lastFailedAt: (r.last_failed_at as number) || undefined,
    failCount: r.fail_count as number,
    usageCount: r.usage_count as number,
    lastError: (r.last_error as string) || undefined,
    createdAt: r.created_at as number,
  };
}

export function listEntries(providerId?: string): PoolEntry[] {
  const db = getDb();
  const sql = providerId
    ? "SELECT * FROM key_pool WHERE provider_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM key_pool ORDER BY created_at DESC";
  const rows = providerId
    ? (db.prepare(sql).all(providerId) as Record<string, unknown>[])
    : (db.prepare(sql).all() as Record<string, unknown>[]);
  return rows.map((r) => mapRow(r)!).filter(Boolean);
}

export function getEntry(id: string): PoolEntry | undefined {
  const db = getDb();
  return mapRow(db.prepare("SELECT * FROM key_pool WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}

export function createEntry(input: CreatePoolEntryInput): PoolEntry {
  if (!input.providerId) throw new Error("providerId is required");
  if (!input.apiKey) throw new Error("apiKey is required");
  if (!input.label) throw new Error("label is required");
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO key_pool
      (id, label, provider_id, api_key, base_url, proxy_url, enabled, weight, status, fail_count, usage_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, ?)`
  ).run(
    id,
    input.label,
    input.providerId,
    input.apiKey,
    input.baseUrl ?? null,
    input.proxyUrl ?? null,
    input.enabled === false ? 0 : 1,
    Math.max(1, Math.min(100, input.weight ?? 1)),
    now
  );
  return getEntry(id)!;
}

export function updateEntry(id: string, patch: Partial<CreatePoolEntryInput & { enabled?: boolean }>): PoolEntry | undefined {
  const cur = getEntry(id);
  if (!cur) return undefined;
  const db = getDb();
  const nextLabel = patch.label ?? cur.label;
  const nextApiKey = patch.apiKey ?? cur.apiKey;
  const nextBaseUrl = patch.baseUrl !== undefined ? (patch.baseUrl || null) : (cur.baseUrl ?? null);
  const nextProxyUrl = patch.proxyUrl !== undefined ? (patch.proxyUrl || null) : (cur.proxyUrl ?? null);
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (cur.enabled ? 1 : 0);
  const nextWeight = patch.weight !== undefined ? Math.max(1, Math.min(100, patch.weight)) : cur.weight;
  db.prepare(
    `UPDATE key_pool
       SET label = ?, api_key = ?, base_url = ?, proxy_url = ?, enabled = ?, weight = ?
     WHERE id = ?`
  ).run(nextLabel, nextApiKey, nextBaseUrl, nextProxyUrl, nextEnabled, nextWeight, id);
  return getEntry(id);
}

export function deleteEntry(id: string): void {
  getDb().prepare("DELETE FROM key_pool WHERE id = ?").run(id);
}

/**
 * Round-robin selection: among enabled entries for `providerId` that are
 * either 'active' or have passed their cooldown, pick the one with the
 * oldest `last_used_at` (NULL = never used, sorts first). Updates
 * `last_used_at` and `usage_count` on the picked entry.
 *
 * Returns null when no usable entry exists.
 */
export function pickKey(providerId: string): PickedKey | null {
  const db = getDb();
  const now = Date.now();
  // Sweep expired cooldowns inline so the ORDER BY picks them up.
  db.prepare(
    "UPDATE key_pool SET status = 'active', cooldown_until = NULL WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?"
  ).run(now);

  const row = db
    .prepare(
      `SELECT * FROM key_pool
        WHERE provider_id = ?
          AND enabled = 1
          AND status IN ('active')
        ORDER BY COALESCE(last_used_at, 0) ASC, usage_count ASC
        LIMIT 1`
    )
    .get(providerId) as Record<string, unknown> | undefined;
  const entry = mapRow(row);
  if (!entry) return null;

  db.prepare(
    "UPDATE key_pool SET last_used_at = ?, usage_count = usage_count + 1 WHERE id = ?"
  ).run(now, entry.id);

  return {
    entry,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl,
    proxyUrl: entry.proxyUrl,
    poolEntryId: entry.id,
  };
}

/**
 * Mark an entry as cooled-down for the next `cooldownMs` milliseconds.
 * The next pickKey() will skip it until cooldown_until elapses. Records the
 * failure reason and bumps fail_count.
 */
export function markCooldown(id: string, cooldownMs = DEFAULT_COOLDOWN_MS, lastError?: string): void {
  const db = getDb();
  const ms = Math.max(1_000, Math.min(MAX_COOLDOWN_MS, cooldownMs));
  const until = Date.now() + ms;
  db.prepare(
    `UPDATE key_pool
        SET status = 'cooldown',
            cooldown_until = ?,
            last_failed_at = ?,
            fail_count = fail_count + 1,
            last_error = ?
      WHERE id = ?`
  ).run(until, Date.now(), lastError ?? null, id);
}

/** Mark an entry as healthy after a successful call. Resets fail_count. */
export function markSuccess(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE key_pool
        SET status = 'active',
            cooldown_until = NULL,
            fail_count = 0,
            last_error = NULL
      WHERE id = ?`
  ).run(id);
}

/** Manually revive a cooled-down / disabled entry (admin action). */
export function resetCooldown(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE key_pool
        SET status = 'active',
            cooldown_until = NULL,
            last_error = NULL
      WHERE id = ?`
  ).run(id);
}

/** Background-swept revival of cooldown entries whose timer has elapsed. */
export function sweepExpiredCooldowns(): number {
  const db = getDb();
  const now = Date.now();
  const r = db
    .prepare(
      "UPDATE key_pool SET status = 'active', cooldown_until = NULL WHERE status = 'cooldown' AND cooldown_until IS NOT NULL AND cooldown_until <= ?"
    )
    .run(now);
  return r.changes ?? 0;
}

export interface PoolStatsRow {
  providerId: string;
  total: number;
  active: number;
  cooldown: number;
  disabled: number;
  totalUsage: number;
  totalFailures: number;
}

export function poolStats(): PoolStatsRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         provider_id as providerId,
         COUNT(*) as total,
         SUM(CASE WHEN status='active' AND enabled=1 THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN status='cooldown' THEN 1 ELSE 0 END) as cooldown,
         SUM(CASE WHEN enabled=0 THEN 1 ELSE 0 END) as disabled,
         COALESCE(SUM(usage_count), 0) as totalUsage,
         COALESCE(SUM(fail_count), 0) as totalFailures
       FROM key_pool
       GROUP BY provider_id
       ORDER BY provider_id`
    )
    .all() as PoolStatsRow[];
  return rows;
}

export function entriesForProvider(providerId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM key_pool WHERE provider_id = ? AND enabled = 1")
    .get(providerId) as { n: number };
  return row?.n ?? 0;
}

/** Sweep loop — call once and re-schedule via setInterval. */
export function startCooldownSweeper(intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const n = sweepExpiredCooldowns();
      if (n > 0) console.log(`[key-pool] revived ${n} cooled-down entries`);
    } catch (err) {
      console.error("[key-pool] sweep error:", err);
    }
  }, intervalMs);
}
