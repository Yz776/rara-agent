# KRouter - Production Docker Image
# Multi-stage build for optimal image size

# Stage 1: Build
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the application (if needed)
RUN bun run build || true

# Stage 2: Production
FROM oven/bun:1-slim AS production

# Set environment variables
ENV NODE_ENV=production
ENV BUN_ENV=production
PORT=3000

# Create non-root user for security
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser

# Create necessary directories
RUN mkdir -p /app/data /app/logs /app/backups && \
    chown -R appuser:appgroup /app

# Copy from builder
COPY --from=builder --chown=appuser:appgroup /app /app
COPY --from=builder --chown=appuser:appgroup /app/node_modules /app/node_modules

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["bun", "run", "src/index.ts"]
