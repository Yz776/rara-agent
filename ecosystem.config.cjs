/**
 * Rara Agent — PM2 ecosystem config (bare-metal / VPS deployment)
 *
 * Starts both processes in production mode:
 *   - rara-web      : Next.js 16 standalone server on :3000
 *   - rara-zrouter  : zrouter gateway on 127.0.0.1:3001 (localhost-only)
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs rara
 *   pm2 restart rara
 *   pm2 stop all && pm2 delete all
 *
 * Auto-restart on crash (max 10 retries in 1 hour, then stops to avoid
 * crash loops). Logs go to ~/.pm2/logs/rara-web-out.log etc.
 *
 * Replace `${ENV_VAR}` placeholders with your actual secrets before starting,
 * OR set them in your shell environment / .env file.
 */

module.exports = {
  apps: [
    {
      name: "rara-web",
      script: ".next/standalone/server.js",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOST: "0.0.0.0",
        // Set via shell env or .env file — must be present before `pm2 start`.
        KROUTER_BASE: process.env.KROUTER_BASE || "http://127.0.0.1:3001",
        KROUTER_INTERNAL_TOKEN: process.env.KROUTER_INTERNAL_TOKEN,
        KFAI_AUTH_SECRET: process.env.KFAI_AUTH_SECRET,
        DATABASE_URL: process.env.DATABASE_URL || "file:./db/rara.db",
        MCP_ENDPOINT: process.env.MCP_ENDPOINT || "http://127.0.0.1:3001/mcp",
        RARA_BASE_URL: process.env.RARA_BASE_URL || "http://127.0.0.1:3000",
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
    {
      name: "rara-zrouter",
      script: "mini-services/zrouter/src/index.ts",
      interpreter: "bun",
      env: {
        NODE_ENV: "production",
        // CRITICAL: bind to localhost only. External callers cannot reach zrouter.
        HOST: "127.0.0.1",
        PORT: 3001,
        KROUTER_DATA_DIR: "./mini-services/zrouter/data",
        KROUTER_INTERNAL_TOKEN: process.env.KROUTER_INTERNAL_TOKEN,
        KROUTER_ADMIN_USERNAME: process.env.KROUTER_ADMIN_USERNAME || "admin",
        KROUTER_ADMIN_PASSWORD: process.env.KROUTER_ADMIN_PASSWORD,
      },
      env_production: {
        NODE_ENV: "production",
      },
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "512M",
      out_file: "./logs/rara-zrouter-out.log",
      error_file: "./logs/rara-zrouter-err.log",
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
    },
  ],
};
