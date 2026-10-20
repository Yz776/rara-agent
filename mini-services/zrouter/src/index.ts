/**
 * KRouter — Bun + ElysiaJS AI Gateway
 *
 * Endpoints:
 *   POST /v1/chat/completions      — OpenAI-compatible chat (stream + non-stream)
 *   POST /v1/messages              — Anthropic-compatible messages (stream + non-stream)
 *   POST /v1/embeddings            — OpenAI-compatible embeddings
 *   GET  /v1/models                — OpenAI-compatible model list
 *   GET  /health                   — Health check
 *   *    /admin/api/*              — Admin REST API (keys, providers, fallbacks, combos, usage, tunnel, oauth)
 *   GET  /                         — Dashboard SPA
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chatRoutes } from "./routes/chat";
import { messagesRoutes } from "./routes/messages";
import { embeddingsRoutes } from "./routes/embeddings";
import { imageRoutes } from "./routes/images";
import { modelsRoutes } from "./routes/models";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { oauthRoutes } from "./routes/oauth";
import { tunnelRoutes } from "./routes/tunnel";
import { proxyRoutes } from "./routes/proxy";
import { poolRoutes } from "./routes/pool";
import { tokenRoutes } from "./routes/tokens";
import { playgroundRoutes } from "./routes/playground";
import { featuresRoutes } from "./routes/features";
import { startTokenRefreshSweeper } from "./services/token-refresh";
import { startProxyRefresher } from "./services/proxy-refresher";
import { startCooldownSweeper } from "./services/key-pool";
import { ensureDefaultAdmin } from "./services/auth-user";
import { handleMcp, mcpInfo } from "./services/mcp-server";
import { dataDir } from "./services/paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
const HOST = process.env.HOST || "0.0.0.0";

// Configure rate limiting based on environment (configured in route middleware)
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60 * 1000); // 1 minute
const rateLimitMaxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 100);

const app = new Elysia()
  .use(cors({
    origin: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version", "anthropic-beta"],
    exposedHeaders: ["X-Request-Id", "X-Accel-Buffering", "Retry-After"],
    credentials: true,
    maxAge: "86400",
  }))
  .use(staticPlugin({ assets: PUBLIC_DIR, prefix: "/" }))
  // Basic logging for all requests
  .onRequest(({ request }) => {
    console.log("[index.ts] Request:", request.method, request.url);
  })
  .onError(({ code, error, set }) => {
    console.log("[index.ts] Error:", code, error?.message);
    const message = error instanceof Error ? error.message : String(error);
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: { message: `Not found: ${message}`, type: "not_found" } };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: { message, type: "validation_error" } };
    }
    set.status = 500;
    return { error: { message, type: "internal_error" } };
  })
  .use(adminRoutes)
  .use(authRoutes)
  .use(oauthRoutes)
  .use(tunnelRoutes)
  .use(proxyRoutes)
  .use(poolRoutes)
  .use(tokenRoutes)
  .use(playgroundRoutes)
  .use(featuresRoutes)
  .use(modelsRoutes)
  .use(embeddingsRoutes)
  .use(imageRoutes)
  .use(messagesRoutes)
  .use(chatRoutes)
  // CORS: let web clients anywhere call the OpenAI-compatible API and MCP.
  // Handles preflight so browser apps (chat UIs, MCP web clients) work.
  .onRequest(({ request, set }) => {
    const path = new URL(request.url).pathname;
    const corsPaths = ["/v1/", "/models", "/mcp", "/embeddings", "/images/", "/messages"];
    if (!corsPaths.some((p) => path === p || path.startsWith(p))) return;
    set.headers["Access-Control-Allow-Origin"] = "*";
    set.headers["Access-Control-Allow-Headers"] =
      "Authorization, Content-Type, x-api-key, Mcp-Session-Id, Anthropic-Version, anthropic-version";
    set.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  })
  .options("/v1/*", () => new Response(null, { status: 204 }))
  .options("/mcp", () => new Response(null, { status: 204 }))
  .options("/mcp/*", () => new Response(null, { status: 204 }))
  .options("/models", () => new Response(null, { status: 204 }))
  // MCP server. Clients (ZCode, OpenClaw) connect here; KRouter is not an MCP client.
  .all("/mcp", ({ request }) => handleMcp(request))
  .get("/mcp/info", () => mcpInfo())
  // Health check
  .get("/health", () => ({ ok: true, ts: Date.now() }))
  // Root → dashboard
  .get("/", () => {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      return new Response(fs.readFileSync(indexPath, "utf8"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("KRouter running. Dashboard not found.", {
      headers: { "Content-Type": "text/plain" },
    });
  })
  // 404 fallback
  .onError(({ code, error, set }) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[error] ${code}: ${message}`);
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: { message: `Not found: ${message}`, type: "not_found" } };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: { message, type: "validation_error" } };
    }
    set.status = 500;
    return { error: { message, type: "internal_error" } };
  })
  .listen({ port: PORT, hostname: HOST });

// Start the background OAuth token refresh sweeper
startTokenRefreshSweeper();
startProxyRefresher();
startCooldownSweeper();

// Auto-create the default admin user on a fresh install (admin/password123).
// Idempotent — only creates the admin if the users table is empty.
ensureDefaultAdmin();

const DISPLAY_HOST = HOST === "0.0.0.0" ? "localhost" : HOST;
console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   KRouter — AI Gateway (Bun + ElysiaJS) v2.0                ║
║                                                              ║
║   Listening on  http://${DISPLAY_HOST}:${PORT}`.padEnd(62) + `║
║   Dashboard    http://${DISPLAY_HOST}:${PORT}/`.padEnd(62) + `║
║   API base    http://${DISPLAY_HOST}:${PORT}/v1`.padEnd(62) + `║
║   Bind host    ${HOST}`.padEnd(62) + `║
║   Data dir     ${dataDir()}`.slice(0, 62).padEnd(62) + `║
║                                                              ║
║   OpenAI-compatible:                                         ║
║     POST /v1/chat/completions                                ║
║     POST /v1/embeddings                                      ║
║     GET  /v1/models                                          ║
║                                                              ║
║   Anthropic-compatible:                                      ║
║     POST /v1/messages                                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

export type App = typeof app;
