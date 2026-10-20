/**
 * Rara Agent — PM2 ecosystem config (bare-metal / VPS deployment)
 *
 * Self-contained: only Next.js runs. No external zrouter gateway.
 * All AI calls go directly to https://opencode.ai from inside Next.js.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs rara-web
 *   pm2 restart rara-web
 *   pm2 stop rara-web && pm2 delete rara-web
 *
 * Auto-restart on crash (max 10 retries in 1 hour, then stops to avoid
 * crash loops). Logs go to ~/.pm2/logs/rara-web-out.log etc.
 *
 * Required env (set in .env or shell):
 *   KFAI_AUTH_SECRET        — random hex string used to sign JWTs (openssl rand -hex 24)
 *   KROUTER_ADMIN_PASSWORD  — admin panel login password (openssl rand -base64 18)
 *   DATABASE_URL            — Prisma SQLite URL (default: file:./db/rara.db)
 *
 * Optional env:
 *   OPENCODE_API_KEY        — real opencode.ai account Bearer (default: free-tier "public")
 */

module.exports = {
  apps: [
    {
      name: "rara-web",
      script: ".next/standalone/server.js",
      interpreter: "node",
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        // Port 3002 — matches nginx upstream `rara_web` (rara.ai.id → 127.0.0.1:3002).
        // Other apps on this host: 3000 = WhatsApp bot, 3003 = catur,
        // 3051 = animest, 47291 = cloud-storage.
        PORT: 3002,
        // CRITICAL: HOSTNAME must be 0.0.0.0, NOT the container hostname
        // (which is "kali" by default and unresolvable → ENOTFOUND crash).
        HOSTNAME: "0.0.0.0",
        KFAI_AUTH_SECRET: process.env.KFAI_AUTH_SECRET,
        KROUTER_ADMIN_PASSWORD: process.env.KROUTER_ADMIN_PASSWORD,
        KROUTER_ADMIN_USERNAME: process.env.KROUTER_ADMIN_USERNAME || "admin",
        // Prisma SQLite DB — file path inside the container.
        DATABASE_URL: process.env.DATABASE_URL || "file:/app/db/rara.db",
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || "",
        RARA_BASE_URL: process.env.RARA_BASE_URL || "http://127.0.0.1:3002",
        // Legacy env kept for backward-compat — no longer used to reach an
        // external zrouter. All AI calls go directly to https://opencode.ai.
        KROUTER_BASE: "",
        KROUTER_INTERNAL_TOKEN: "",
        MCP_ENDPOINT: "",
      },
      env_production: {
        NODE_ENV: "production",
      },
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "1G",
      out_file: "./logs/rara-web-out.log",
      error_file: "./logs/rara-web-err.log",
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
    },
  ],
};
