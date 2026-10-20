# ─────────────────────────────────────────────────────────────────────────────
# Rara Agent — Production Dockerfile (self-contained, no zrouter)
#
# Single image running:
#   - Next.js 16 (standalone output) on :3000
#   - Bundled opencode.ai free-tier gateway inside Next.js (server-side)
#
# No external services needed. All AI calls go directly to https://opencode.ai
# from inside the Next.js process. The free-tier "Bearer public" credential is
# hardcoded; set OPENCODE_API_KEY env to upgrade to a real opencode.ai account.
#
# Build:
#   docker build -t rara-agent:latest .
#
# Run:
#   docker run -d --name rara -p 3000:3000 \
#     -e KFAI_AUTH_SECRET=$(openssl rand -hex 24) \
#     -e KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18) \
#     -v rara_data:/app/data \
#     -v rara_db:/app/db \
#     rara-agent:latest
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build Next.js ──────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Build-time env. DATABASE_URL must be set so Prisma validate + generate
# succeed during `next build`.
ENV DATABASE_URL=file:/tmp/rara-build-validate.db \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=true

# Copy package.json + lockfile first for cache.
COPY package.json bun.lock* package-lock.json* ./

# Install deps (use npm — bun is not strictly needed for a Next.js-only build).
RUN if [ -f bun.lock ]; then \
      npm install --no-audit --no-fund --omit=optional || npm install --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

# Copy the rest of the source.
COPY . .

# Generate Prisma client.
RUN npx prisma generate || true

# Build Next.js (produces .next/standalone + .next/static).
RUN npm run build

# ── Stage 2: production runtime ─────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Copy standalone Next.js output (preserves the .next/standalone/ directory
# structure so `node .next/standalone/server.js` works as-is).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules

# Copy prisma schema + migrations (so we can push at runtime).
COPY --from=builder /app/prisma ./prisma

# Default env. Override at runtime via -e flags.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=file:/app/db/rara.db \
    NEXT_TELEMETRY_DISABLED=1

# Minimal runtime deps.
RUN apk add --no-cache ca-certificates tini \
    && mkdir -p /app/data /app/db

# Expose ONLY the Next.js port.
EXPOSE 3000

# Healthcheck: hit Next.js root.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

# Volume for persistent state (Prisma SQLite db + per-user sandbox files).
VOLUME ["/app/data", "/app/db"]

# Use tini as PID 1 to handle SIGTERM cleanly.
ENTRYPOINT ["/sbin/tini", "--"]

# Push prisma schema (creates DB if missing), then start the Next.js server.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss 2>/dev/null || true; exec node server.js"]
