/**
 * Centralised data-directory resolution for KRouter.
 *
 * Every service that persists state to disk (SQLite DBs, config.json, logs,
 * backups) resolves its path through this helper so that all mutable data
 * lives under a single, configurable root.
 *
 * Resolution order (first match wins):
 *   1. KROUTER_DATA_DIR           — explicit data dir (e.g. /home/container/data on Pterodactyl)
 *   2. KROUTER_DB_PATH parent     — if the operator already set a DB path, keep everything alongside it
 *   3. ~/.krouter                  — default per-user directory (local dev / Docker HOME=/app)
 *   4. /tmp/.krouter               — last-resort writable directory
 *
 * This makes the app portable across:
 *   - Local dev (macOS/Linux):              ~/.krouter/
 *   - Docker (HOME=/app):                   /app/.krouter/
 *   - Pterodactyl (KROUTER_DATA_DIR set):   /home/container/data/
 *   - Any custom hosting via env override.
 */

import path from "node:path";
import fs from "node:fs";

const FALLBACK_DIR = "/tmp";

function computeDataDir(): string {
  // 1. Explicit data directory (preferred for Pterodactyl / custom hosting)
  if (process.env.KROUTER_DATA_DIR) {
    return process.env.KROUTER_DATA_DIR;
  }

  // 2. If the operator set a DB path, co-locate everything next to it
  if (process.env.KROUTER_DB_PATH) {
    return path.dirname(process.env.KROUTER_DB_PATH);
  }

  // 3. ~/.krouter (works for local dev and Docker images where HOME=/app)
  const home = process.env.HOME || process.env.USERPROFILE || FALLBACK_DIR;
  return path.join(home, ".krouter");
}

let cachedDataDir: string | null = null;

/**
 * Returns the (cached) data directory, creating it if it does not yet exist.
 * Safe to call multiple times.
 */
export function dataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  const dir = computeDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // If we cannot create the preferred dir, fall back to /tmp/.krouter
    // so the server can still boot instead of crashing on a read-only fs.
    const fallback = path.join(FALLBACK_DIR, ".krouter");
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      /* give up silently */
    }
    cachedDataDir = fallback;
    return fallback;
  }
  cachedDataDir = dir;
  return dir;
}

/**
 * Resolve a filename relative to the data directory.
 * Use for SQLite DBs, config.json, backups, etc.
 *
 *   dataFile("krouter.db")     -> /home/container/data/krouter.db
 *   dataFile("backups", "b.zip") -> /home/container/data/backups/b.zip
 */
export function dataFile(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
}

/**
 * Resolve the logs directory (sibling of the data dir by default, or a
 * `logs` subdirectory inside it). Used by services that write log files.
 */
export function logsDir(): string {
  if (process.env.KROUTER_LOGS_DIR) return process.env.KROUTER_LOGS_DIR;
  return dataFile("logs");
}
