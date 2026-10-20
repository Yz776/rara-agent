/**
 * Proxy Manager Service
 * 
 * Features:
 * - Proxy pool management (add/remove/list)
 * - Auto-detection on IP block errors
 * - Public proxy scraping from multiple sources
 * - Proxy validation and performance testing
 * - Round-robin or random rotation
 */

import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { dataFile } from "./paths";

const DEFAULT_DB_PATH = dataFile("proxies.db");

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  const p = DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  initSchema(db);
  return db;
}

function initSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS proxies (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'http',
      username TEXT,
      password TEXT,
      country TEXT,
      last_checked_at INTEGER NOT NULL,
      response_time_ms INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_anonymous INTEGER DEFAULT 0,
      uptime_score REAL DEFAULT 0.0,
      created_at INTEGER NOT NULL,
      check_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS proxy_blacklist (
      id TEXT PRIMARY KEY,
      host TEXT UNIQUE NOT NULL,
      reason TEXT,
      blacklisted_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_proxies_active ON proxies(is_active, uptime_score DESC);
    CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
    CREATE INDEX IF NOT EXISTS idx_proxies_response_time ON proxies(response_time_ms ASC);
  `);
}

export interface Proxy {
  id: string;
  host: string;
  port: number;
  protocol: "http" | "https" | "socks4" | "socks5";
  username?: string;
  password?: string;
  country?: string;
  lastCheckedAt: number;
  responseTimeMs: number;
  isActive: boolean;
  isAnonymous: boolean;
  uptimeScore: number;
  createdAt: number;
  checkCount: number;
  failedCount: number;
}

export function addProxy(proxy: Omit<Proxy, "id" | "createdAt">): Proxy {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO proxies (id, host, port, protocol, username, password, country,
     last_checked_at, response_time_ms, is_active, is_anonymous, uptime_score, check_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    proxy.host,
    proxy.port,
    proxy.protocol,
    proxy.username ?? null,
    proxy.password ?? null,
    proxy.country ?? null,
    proxy.lastCheckedAt ?? now,
    proxy.responseTimeMs,
    proxy.isActive ? 1 : 0,
    proxy.isAnonymous ? 1 : 0,
    proxy.uptimeScore,
    proxy.checkCount,
    now
  );

  return {
    ...proxy,
    id,
    createdAt: now,
  };
}

export function removeProxy(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM proxies WHERE id = ?").run(id);
}

export function blacklistProxy(host: string, reason: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO proxy_blacklist (id, host, reason, blacklisted_at) VALUES (?, ?, ?, ?)"
  ).run(crypto.randomUUID(), host, reason, Date.now());
}

export function isHostBlacklisted(host: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT id FROM proxy_blacklist WHERE host = ?").get(host);
  return !!row;
}

export function findProxy(id: string): Proxy | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM proxies WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return parseRow(row);
}

export function listProxies(filter?: {
  active?: boolean;
  country?: string;
  protocol?: string;
}): Proxy[] {
  const db = getDb();
  
  let query = "SELECT * FROM proxies WHERE 1=1";
  const params: unknown[] = [];
  
  if (filter?.active !== undefined) {
    query += " AND is_active = ?";
    params.push(filter.active ? 1 : 0);
  }
  
  if (filter?.country) {
    query += " AND country = ?";
    params.push(filter.country);
  }
  
  if (filter?.protocol) {
    query += " AND protocol = ?";
    params.push(filter.protocol);
  }
  
  query += " ORDER BY uptime_score DESC, response_time_ms ASC LIMIT 200";
  
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(parseRow);
}

function parseRow(row: Record<string, unknown>): Proxy {
  return {
    id: row.id as string,
    host: row.host as string,
    port: row.port as number,
    protocol: row.protocol as Proxy["protocol"],
    username: row.username as string | undefined,
    password: row.password as string | undefined,
    country: row.country as string | undefined,
    lastCheckedAt: row.last_checked_at as number,
    responseTimeMs: row.response_time_ms as number,
    isActive: Boolean(row.is_active),
    isAnonymous: Boolean(row.is_anonymous),
    uptimeScore: row.uptime_score as number,
    createdAt: row.created_at as number,
    checkCount: row.check_count as number,
    failedCount: row.failed_count as number,
  };
}

export function updateProxyStatus(id: string, options?: Partial<{
  responseTimeMs: number;
  lastCheckedAt: number;
  checkCount: number;
  failedCount: number;
  uptimeScore: number;
  isActive: boolean;
}>): void {
  const db = getDb();
  
  const sets: string[] = [];
  const values: unknown[] = [];
  
  if (options?.responseTimeMs !== undefined) {
    sets.push("response_time_ms = ?");
    values.push(options.responseTimeMs);
  }
  
  if (options?.lastCheckedAt !== undefined) {
    sets.push("last_checked_at = ?");
    values.push(options.lastCheckedAt);
  }
  
  if (options?.checkCount !== undefined) {
    sets.push("check_count = check_count + ?");
    values.push(options.checkCount);
  }
  
  if (options?.failedCount !== undefined) {
    sets.push("failed_count = failed_count + ?");
    values.push(options.failedCount);
  }
  
  if (options?.uptimeScore !== undefined) {
    sets.push("uptime_score = ?");
    values.push(options.uptimeScore);
  }
  
  if (options?.isActive !== undefined) {
    sets.push("is_active = ?");
    values.push(options.isActive ? 1 : 0);
  }
  
  if (sets.length > 0) {
    // Also bump last_checked_at as the "updated" timestamp (the schema has no
    // dedicated `updated_at` column).
    values.push(id);
    db.prepare(`UPDATE proxies SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
}

// ==================== PROXY SELECTION ====================

export function selectNextProxy(): Proxy | undefined {
  const db = getDb();

  // Get blacklist hosts
  const blacklist = db.prepare("SELECT host FROM proxy_blacklist").all() as { host: string }[];
  const blacklistedHosts = blacklist.map((r) => r.host);

  // Build the query dynamically. When the blacklist is empty we use a harmless
  // `host NOT NULL` predicate so the prepared statement still has 0 params.
  const excludeClause = blacklistedHosts.length > 0
    ? `AND host NOT IN (${blacklistedHosts.map(() => "?").join(",")})`
    : `AND host IS NOT NULL`;

  const rows = db.prepare(
    `SELECT * FROM proxies
     WHERE is_active = 1 ${excludeClause}
     ORDER BY uptime_score DESC, response_time_ms ASC, check_count ASC
     LIMIT 100`
  ).all(...blacklistedHosts) as Record<string, unknown>[];

  if (rows.length === 0) return undefined;

  // Pick one with bias toward faster/better proxies (weighted random)
  const weighted = rows.map((row) => ({
    row,
    weight: (row.uptime_score as number) / ((row.response_time_ms as number) + 100),
  }));
  const totalWeight = weighted.reduce((sum, w) => sum + Math.max(w.weight, 1e-6), 0);

  let random = Math.random() * totalWeight;
  for (const { row, weight } of weighted) {
    random -= Math.max(weight, 1e-6);
    if (random <= 0) return parseRow(row);
  }

  return parseRow(rows[rows.length - 1]);
}

export function selectRandomActiveProxy(): Proxy | undefined {
  const db = getDb();

  const blacklistResult = db.prepare("SELECT host FROM proxy_blacklist").all() as { host: string }[];
  const blacklistedHosts = blacklistResult.map((r) => r.host);

  const excludeClause = blacklistedHosts.length > 0
    ? `AND host NOT IN (${blacklistedHosts.map(() => "?").join(",")})`
    : `AND host IS NOT NULL`;

  const query = `SELECT * FROM proxies
                 WHERE is_active = 1 ${excludeClause}
                 ORDER BY RANDOM() LIMIT 1`;

  const rows = db.prepare(query).all(...blacklistedHosts) as Record<string, unknown>[];
  if (rows.length === 0) return undefined;
  return parseRow(rows[0]!);
}

// ==================== AUTO-ROTATION LOGIC ====================

export function shouldRotateOnError(statusCode: number): boolean {
  // Common status codes indicating IP block
  return [
    403, // Forbidden (often IP ban)
    429, // Too Many Requests
    503, // Service Unavailable
    407, // Proxy Authentication Required
  ].includes(statusCode);
}

export function handleBlockedIp(blockedHost: string): void {
  blacklistProxy(blockedHost, `Blocked at ${new Date().toISOString()}`);
  updateProxyStatusForHost(blockedHost, { isActive: false });
}

function updateProxyStatusForHost(host: string, updates: Partial<{ isActive: boolean }>): void {
  const db = getDb();
  if (updates.isActive === undefined) return;
  db.prepare("UPDATE proxies SET is_active = ? WHERE host = ?").run(updates.isActive ? 1 : 0, host);
}

export function rotateProxyAfterFailure(proxyId: string): void {
  const prev = findProxy(proxyId);
  updateProxyStatus(proxyId, {
    failedCount: 1,
    uptimeScore: Math.max(0, (prev?.uptimeScore ?? 0) - 0.1),
    isActive: false, // Deactivate temporarily so the next pick skips it
  });
}

// ==================== VALIDATION ====================

export interface ProxyHealthResult {
  id: string;
  host: string;
  port: number;
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
}

const HEALTH_URL = "https://opencode.ai/zen/v1/models";

/**
 * Check one proxy against the real upstream (OpenCode free tier), not a local
 * page. A proxy that only reaches example.com still fails provider calls.
 */
export async function checkProxyHealth(
  proxy: Proxy,
  timeoutMs = 8000
): Promise<ProxyHealthResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${proxy.protocol}://${
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : ""
  }${proxy.host}:${proxy.port}`;
  try {
    const res = await fetch(HEALTH_URL, {
      proxy: url,
      headers: { Authorization: "Bearer public", "User-Agent": "opencode" },
      signal: controller.signal,
    } as RequestInit & { proxy?: string });
    const latencyMs = Date.now() - start;
    const ok = res.ok;
    await res.text().catch(() => undefined);
    const prev = findProxy(proxy.id);
    updateProxyStatus(proxy.id, {
      responseTimeMs: latencyMs,
      lastCheckedAt: Date.now(),
      checkCount: 1,
      uptimeScore: ok
        ? Math.min(1, (prev?.uptimeScore ?? 0) + 0.15)
        : Math.max(0, (prev?.uptimeScore ?? 0) - 0.25),
      isActive: ok,
      failedCount: ok ? 0 : 1,
    });
    return { id: proxy.id, host: proxy.host, port: proxy.port, ok, status: res.status, latencyMs };
  } catch (err) {
    const prev = findProxy(proxy.id);
    updateProxyStatus(proxy.id, {
      lastCheckedAt: Date.now(),
      checkCount: 1,
      failedCount: 1,
      uptimeScore: Math.max(0, (prev?.uptimeScore ?? 0) - 0.25),
      isActive: false,
    });
    return {
      id: proxy.id,
      host: proxy.host,
      port: proxy.port,
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the pool a few at a time so a large scrape does not stampede. */
export async function checkAllProxyHealth(
  concurrency = 6,
  timeoutMs = 8000
): Promise<{ checked: number; healthy: number; dead: number; results: ProxyHealthResult[] }> {
  const proxies = listProxies();
  const results: ProxyHealthResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < proxies.length) {
      const proxy = proxies[cursor++]!;
      results.push(await checkProxyHealth(proxy, timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, proxies.length) }, () => worker()));
  const healthy = results.filter((r) => r.ok).length;
  return { checked: results.length, healthy, dead: results.length - healthy, results };
}

/** Drop proxies that failed the last health check. */
export function removeInactiveProxies(): number {
  const db = getDb();
  const result = db.prepare("DELETE FROM proxies WHERE is_active = 0").run();
  return result.changes ?? 0;
}

export async function validateProxy(proxy: Proxy): Promise<boolean> {
  try {
    const start = Date.now();
    
    // Test connection
    const testUrl = "http://example.com";
    const headers: Record<string, string> = {};
    if (proxy.username && proxy.password) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
      headers["Proxy-Authorization"] = `Basic ${auth}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const proxyUrl = `${proxy.protocol}://${
      proxy.username && proxy.password
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
        : ""
    }${proxy.host}:${proxy.port}`;
    const res = await fetch(testUrl, {
      proxy: proxyUrl,
      headers,
      signal: controller.signal,
    } as RequestInit & { proxy?: string });
    
    clearTimeout(timeout);
    
    const responseTime = Date.now() - start;
    
    // Update stats (note: schema has no success_count column; we infer health
    // from uptime_score + is_active only)
    const prev = findProxy(proxy.id);
    updateProxyStatus(proxy.id, {
      responseTimeMs: responseTime,
      lastCheckedAt: Date.now(),
      checkCount: 1,
      uptimeScore: res.ok
        ? Math.min(1.0, (prev?.uptimeScore ?? 0) + 0.1)
        : Math.max(0, (prev?.uptimeScore ?? 0) - 0.2),
      isActive: res.ok,
    });

    return res.ok;
  } catch {
    const prev = findProxy(proxy.id);
    updateProxyStatus(proxy.id, {
      failedCount: 1,
      uptimeScore: Math.max(0, (prev?.uptimeScore ?? 0) - 0.2),
      isActive: false,
    });
    return false;
  }
}

// ==================== PUBLIC PROXY SCRAPER ====================

export async function scrapePublicProxies(): Promise<Proxy[]> {
  const sources = [
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=https",
    "https://raw.githubusercontent.com/monosch/proxy/main/proxies.txt",
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    "https://www.proxy-list.uk/downloads/proxy-list.txt",
  ];
  
  const found: Proxy[] = [];
  
  for (const url of sources) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!res.ok) continue;
      
      const text = await res.text();
      const lines = text.split("\n").filter(Boolean);
      
      for (const line of lines) {
        const proxy = parseProxyLine(line);
        if (proxy) {
          if (!isHostBlacklisted(proxy.host)) {
            found.push(proxy);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to scrape ${url}:`, err);
      // Continue with next source
    }
  }
  
  // Deduplicate by host:port
  const unique = new Map<string, Proxy>();
  for (const proxy of found) {
    const key = `${proxy.host}:${proxy.port}`;
    if (!unique.has(key)) {
      unique.set(key, proxy);
    }
  }
  
  return Array.from(unique.values()).slice(0, 50); // Limit to 50
}

function parseProxyLine(line: string): Proxy | null {
  // Format: IP:PORT[:USER[:PASS]] or similar variations
  const patterns = [
    /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)(?::(\w+))?(?::(\w+))?$/,
    /^\[([^\]]+)\]:(\d+)(?::(\w+))?(?::(\w+))?$/,
  ];
  
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      const [, host, portStr, username, password] = match;
      return {
        id: crypto.randomUUID(),
        host,
        port: parseInt(portStr, 10),
        protocol: "http" as const,
        username: username || undefined,
        password: password || undefined,
        lastCheckedAt: Date.now(),
        responseTimeMs: 0,
        isActive: false,
        isAnonymous: false,
        uptimeScore: 0,
        checkCount: 0,
        failedCount: 0,
      };
    }
  }
  
  return null;
}

export async function discoverProxiesViaAI(query: string): Promise<Proxy[]> {
  // Use AI search to find proxy lists from web sources
  // This would integrate with a search API like Google Custom Search
  
  try {
    // Example implementation using Google Custom Search API
    // Replace with your actual API key
    const apiKey = process.env.GOOGLE_API_KEY;
    const cx = process.env.GOOGLE_CX;
    
    if (!apiKey || !cx) {
      console.warn("Google Search credentials not configured, skipping AI discovery");
      return [];
    }
    
    const searchQuery = `${query} proxy list site:.txt OR site:.com`;
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.append("q", searchQuery);
    url.searchParams.append("key", apiKey);
    url.searchParams.append("cx", cx);
    url.searchParams.append("num", "10");
    
    const res = await fetch(url.toString());
    const data = await res.json();
    
    if (!data.items) return [];
    
    const found: Proxy[] = [];
    for (const item of data.items.slice(0, 10)) {
      try {
        const linkRes = await fetch(item.link);
        if (linkRes.ok) {
          const text = await linkRes.text();
          const proxies = parseProxyList(text);
          found.push(...proxies);
        }
      } catch {}
    }
    
    return found.slice(0, 30);
  } catch (err) {
    console.error("AI proxy discovery failed:", err);
    return [];
  }
}

function parseProxyList(text: string): Proxy[] {
  const lines = text.split("\n")
    .filter(Boolean)
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+/.test(l));
  
  return lines.map((line) => {
    const [host, portStr] = line.split(":");
    return {
      id: crypto.randomUUID(),
      host,
      port: parseInt(portStr, 10),
      protocol: "http" as const,
      lastCheckedAt: Date.now(),
      responseTimeMs: 0,
      isActive: false,
      isAnonymous: false,
      uptimeScore: 0,
      checkCount: 0,
      failedCount: 0,
    };
  });
}

export async function bulkAddProxies(proxies: Proxy[]): Promise<void> {
  const db = getDb();
  
  for (const proxy of proxies) {
    try {
      db.prepare(
        `INSERT OR IGNORE INTO proxies 
         (id, host, port, protocol, username, password, country, last_checked_at, 
          response_time_ms, is_active, is_anonymous, uptime_score, check_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        proxy.id,
        proxy.host,
        proxy.port,
        proxy.protocol,
        proxy.username ?? null,
        proxy.password ?? null,
        proxy.country ?? null,
        Date.now(),
        proxy.responseTimeMs,
        proxy.isActive ? 1 : 0,
        proxy.isAnonymous ? 1 : 0,
        proxy.uptimeScore,
        proxy.checkCount,
        Date.now()
      );
    } catch (err) {
      console.error(`Failed to add proxy ${proxy.host}:${proxy.port}:`, err);
    }
  }
}
