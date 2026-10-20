# ─────────────────────────────────────────────────────────────────────────────
# Rara Agent — Production Dockerfile
#
# Single image bundling:
#   - Next.js 16 (standalone output) on :3000
#   - zrouter gateway (Bun + Elysia) on 127.0.0.1:3001
#
# Entrypoint runs both processes via `concurrently`. The Caddyfile at the
# project root or any reverse-proxy in front of :3000 forwards traffic —
# zrouter is bound to 127.0.0.1 inside the container so it is unreachable
# from outside.
#
# Build:
#   docker build -t rara-agent:latest .
#
# Run:
#   docker run -d --name rara -p 3000:3000 \
#     -e KROUTER_INTERNAL_TOKEN=$(openssl rand -hex 32) \
#     -e KFAI_AUTH_SECRET=$(openssl rand -hex 24) \
#     -e KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18) \
#     -v rara_data:/app/data \
#     -v rara_db:/app/db \
#     rara-agent:latest
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build Next.js ──────────────────────────────────────────────────
FROM oven/bun:1.3 AS builder

WORKDIR /app

# Build-time env. DATABASE_URL must be set so Prisma validate + generate
# succeed during `next build` (the standalone server.ts imports db.ts
# which calls new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })).
# This /tmp DB is never actually used — at runtime the operator sets
# DATABASE_URL=file:/app/db/rara.db via docker-compose env.
ENV DATABASE_URL=file:/tmp/rara-build-validate.db \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true

# Copy root package.json + lockfile + zrouter package.json first for cache.
COPY package.json bun.lock ./
COPY mini-services/zrouter/package.json mini-services/zrouter/bun.lock ./mini-services/zrouter/

# Install root deps (postinstall hook installs zrouter deps too).
RUN bun install --frozen-lockfile

# Copy the rest of the source.
COPY . .

# Generate Prisma client (validation only — /tmp DB never written to).
RUN bunx prisma generate || true

# Build Next.js (produces .next/standalone + .next/static).
# `next build` will try to evaluate API routes that import db.ts — the
# DATABASE_URL=/tmp/... env above makes this safe.
RUN bun run build

# ── Stage 2: production runtime ─────────────────────────────────────────────
FROM oven/bun:1.3 AS runtime

WORKDIR /app

# Copy standalone Next.js output (already includes next, react, react-dom, etc.).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bun.lock ./bun.lock
# node_modules: contains concurrently + Prisma client + everything else
COPY --from=builder /app/node_modules ./node_modules

# Copy zrouter source + its deps.
COPY --from=builder /app/mini-services/zrouter ./mini-services/zrouter

# Copy prisma schema + migrations (so we can push at runtime).
COPY --from=builder /app/prisma ./prisma

# Copy Caddyfile (used if the operator wants to run Caddy in the same image).
COPY Caddyfile ./Caddyfile

# Default env. Override at runtime via -e flags.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    KROUTER_BASE=http://127.0.0.1:3001 \
    KROUTER_DATA_DIR=/app/data/mini-services/zrouter/data \
    DATABASE_URL=file:/app/db/rara.db \
    NEXT_TELEMETRY_DISABLED=1

# Create writable dirs at runtime + install minimal process-control deps
# (concurrently → tree-kill needs `ps` to kill process trees)
RUN apt-get update -qq && apt-get install -y --no-install-recommends procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data/mini-services/zrouter/data /app/db

# Expose ONLY the Next.js port. zrouter binds to 127.0.0.1:3001 internally
# and is never reachable from outside the container.
EXPOSE 3000

# Healthcheck: hit Next.js root. zrouter health is internal-only.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Volume for persistent state (zrouter data + prisma db).
VOLUME ["/app/data", "/app/db"]

# Start both processes. The shell form ensures env vars are expanded.
CMD ["sh", "-c", "bun run db:push --accept-data-loss 2>/dev/null || true; exec bun run start"]
