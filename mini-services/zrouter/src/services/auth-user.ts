/**
 * User Authentication Service
 * 
 * Manages:
 * - User creation/login/logout
 * - Password hashing (bcrypt)
 * - Session management
 * - Role-based access control
 */

import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { dataFile } from "./paths";

const DEFAULT_DB_PATH = dataFile("auth.db");

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
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
}

export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: number;
  lastLoginAt?: number;
}

export function createUser(username: string, password: string, role: "admin" | "user" = "user"): AuthUser {
  const db = getDb();
  
  // Check if user exists
  const existing = db.prepare("SELECT id FROM auth_users WHERE username = ?").get(username);
  if (existing) {
    throw new Error("Username already exists");
  }
  
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 12);
  const now = Date.now();
  
  db.prepare(
    "INSERT INTO auth_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, username, passwordHash, role, now);
  
  return { id, username, role, createdAt: now };
}

export function authenticateUser(username: string, password: string): AuthUser | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM auth_users WHERE username = ?").get(username) as Record<string, unknown> | undefined;
  
  if (!row) return undefined;
  
  const isValid = bcrypt.compareSync(password, row.password_hash as string);
  if (!isValid) return undefined;
  
  // Update last login
  db.prepare("UPDATE auth_users SET last_login_at = ? WHERE id = ?").run(Date.now(), row.id);
  
  return {
    id: row.id as string,
    username: row.username as string,
    role: row.role as "admin" | "user",
    createdAt: row.created_at as number,
    lastLoginAt: row.last_login_at as number | undefined,
  };
}

export function findUserById(id: string): AuthUser | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM auth_users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    username: row.username as string,
    role: row.role as "admin" | "user",
    createdAt: row.created_at as number,
    lastLoginAt: row.last_login_at as number | undefined,
  };
}

export function deleteUser(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM auth_users WHERE id = ?").run(id);
  // Also delete their sessions
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
}

export function listUsers(): AuthUser[] {
  const db = getDb();
  return db.prepare("SELECT * FROM auth_users ORDER BY created_at DESC").all() as AuthUser[];
}

export function changePassword(userId: string, newPassword: string): void {
  const db = getDb();
  const passwordHash = bcrypt.hashSync(newPassword, 12);
  db.prepare("UPDATE auth_users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

// ==================== SESSION MANAGEMENT ====================

export interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: number;
  userAgent?: string;
  ipAddress?: string;
  createdAt: number;
}

export function createSession(userId: string, userAgent?: string, ipAddress?: string): SessionRecord {
  const db = getDb();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days
  
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, user_agent, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(token, userId, expiresAt, userAgent, ipAddress, Date.now());
  
  return { token, userId, expiresAt, userAgent, ipAddress, createdAt: Date.now() };
}

export function validateSession(token: string): SessionRecord | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as Record<string, unknown> | undefined;
  
  if (!row) return undefined;
  
  // Check expiry
  if ((row.expires_at as number) < Date.now()) {
    return undefined;
  }
  
  return {
    token: row.token as string,
    userId: row.user_id as string,
    expiresAt: row.expires_at as number,
    userAgent: row.user_agent as string | undefined,
    ipAddress: row.ip_address as string | undefined,
    createdAt: row.created_at as number,
  };
}

export function invalidateSession(token: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function invalidateAllSessionsForUser(userId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function cleanupExpiredSessions(): number {
  const db = getDb();
  const cutoff = Date.now();
  const result = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(cutoff);
  return result.changedRows || 0;
}

export function listActiveSessions(): Array<SessionRecord & { username?: string }> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.*, u.username 
     FROM sessions s 
     JOIN auth_users u ON s.user_id = u.id 
     WHERE s.expires_at > ?`
  ).all(Date.now()) as Record<string, unknown>[];
  
  return rows.map((r) => ({
    token: r.token as string,
    userId: r.user_id as string,
    expiresAt: r.expires_at as number,
    userAgent: r.user_agent as string | undefined,
    ipAddress: r.ip_address as string | undefined,
    createdAt: r.created_at as number,
    username: r.username as string | undefined,
  }));
}

export function logout(userId: string): void {
  invalidateAllSessionsForUser(userId);
}

// ── Default admin bootstrap ──────────────────────────────────────────────────
//
// On a fresh install (no users in the DB), auto-create the default admin
// account so the user can log in immediately without running a setup script.
// Credentials default to admin / password123 but can be overridden via the
// KROUTER_ADMIN_USERNAME / KROUTER_ADMIN_PASSWORD environment variables — useful
// for Pterodactyl / Docker deployments where you want to pre-seed a secure
// admin instead of shipping the well-known default.
// Idempotent: only creates the admin if the users table is empty.

let bootstrapRan = false;

export function ensureDefaultAdmin(): void {
  if (bootstrapRan) return; // only check once per process
  bootstrapRan = true;
  try {
    const db = getDb();
    const count = db.prepare("SELECT COUNT(*) as n FROM auth_users").get() as { n: number } | undefined;
    if (count && count.n > 0) return; // users already exist — don't touch

    // Env-overridable credentials (falls back to admin / password123)
    const username = (process.env.KROUTER_ADMIN_USERNAME || "admin").trim();
    const password = process.env.KROUTER_ADMIN_PASSWORD || "password123";
    if (!username) {
      console.error("[auth] KROUTER_ADMIN_USERNAME is empty — skipping admin bootstrap.");
      return;
    }

    const id = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(password, 12);
    const now = Date.now();
    db.prepare(
      "INSERT INTO auth_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, username, passwordHash, "admin", now);
    if (process.env.KROUTER_ADMIN_PASSWORD) {
      console.log(`[auth] Default admin user created (${username}) from KROUTER_ADMIN_PASSWORD env var.`);
    } else {
      console.log(`[auth] Default admin user created (${username}/password123) — change the password after first login.`);
    }
  } catch (err) {
    console.error("[auth] Failed to bootstrap default admin:", err);
  }
}
