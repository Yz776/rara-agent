/**
 * /admin/api/playground — interactive chat playground.
 *
 * Forwards chat requests from the dashboard's playground UI. The difference
 * from /v1/chat/completions: this route uses session-cookie auth (so the
 * dashboard can call it without an API key), and it logs to a separate
 * playground_conversations table for saving/loading sessions.
 *
 *   POST /playground/chat       — send a chat request (returns full response)
 *   POST /playground/chat/stream — same but streaming SSE
 *   GET  /playground/conversations — list saved conversations
 *   POST /playground/conversations — save a conversation
 *   DELETE /playground/conversations/:id — delete
 */

import { Elysia } from "elysia";
import { authenticate } from "../middleware/auth";
import { isSessionAdmin } from "../middleware/auth";
import * as registry from "../services/registry";
import { resolveCombo } from "../services/combos";
import { isSmartRouteRequest, resolveSmartModel } from "../services/smart-router";
import type { ChatCompletionRequest, ChatCompletionChunk } from "../types";
import { getDb } from "../services/db";
import crypto from "node:crypto";

function err(message: string, status: number) {
  return { error: { message, type: "playground_error", status } };
}

function authGuard(ctx: { request: Request }) {
  if (!authenticate({ request: ctx.request } as never)) {
    throw new Error("Unauthorized");
  }
}

interface PlaygroundMessage {
  role: string;
  content: string;
}

interface PlaygroundConversation {
  id: string;
  title: string;
  model: string;
  messages: PlaygroundMessage[];
  createdAt: number;
  updatedAt: number;
}

function ensureSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      messages TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_playground_conversations_updated ON playground_conversations(updated_at DESC);
  `);
}

export const playgroundRoutes = new Elysia({ prefix: "/admin/api/playground" });

// ── Chat (non-streaming) ─────────────────────────────────────────────────────
playgroundRoutes.post("/chat", async (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    model: string;
    messages: PlaygroundMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
  if (!body.model || !Array.isArray(body.messages)) {
    ctx.set.status = 400;
    return err("model and messages[] required", 400);
  }
  // Resolve smart/<strategy> to a concrete model
  let model = body.model;
  if (isSmartRouteRequest(model)) {
    const resolved = await resolveSmartModel(model, body as ChatCompletionRequest);
    if (resolved) model = resolved;
  }
  // Resolve combo/<id> to first model
  if (model.startsWith("combo/")) {
    const models = resolveCombo(model);
    if (models && models.length > 0) model = models[0]!;
  }
  const req: ChatCompletionRequest = {
    model,
    messages: body.messages as ChatCompletionRequest["messages"],
    temperature: body.temperature,
    max_tokens: body.max_tokens ?? 1024,
    stream: false,
  } as ChatCompletionRequest;
  try {
    const response = await registry.chatCompletion(req);
    return { response, resolvedModel: model };
  } catch (e) {
    ctx.set.status = 502;
    return err(e instanceof Error ? e.message : String(e), 502);
  }
});

// ── Chat (streaming SSE) ─────────────────────────────────────────────────────
playgroundRoutes.post("/chat/stream", async (ctx) => {
  authGuard(ctx);
  const body = (ctx.body ?? {}) as {
    model: string;
    messages: PlaygroundMessage[];
    temperature?: number;
    max_tokens?: number;
  };
  if (!body.model || !Array.isArray(body.messages)) {
    ctx.set.status = 400;
    return err("model and messages[] required", 400);
  }
  let model = body.model;
  if (isSmartRouteRequest(model)) {
    const resolved = await resolveSmartModel(model, body as ChatCompletionRequest);
    if (resolved) model = resolved;
  }
  if (model.startsWith("combo/")) {
    const models = resolveCombo(model);
    if (models && models.length > 0) model = models[0]!;
  }
  const req: ChatCompletionRequest = {
    model,
    messages: body.messages as ChatCompletionRequest["messages"],
    temperature: body.temperature,
    max_tokens: body.max_tokens ?? 1024,
    stream: true,
  } as ChatCompletionRequest;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const gen = registry.chatCompletionStream(req);
        for await (const chunk of gen as AsyncGenerator<ChatCompletionChunk>) {
          send(chunk);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send({ error: { message: msg, type: "playground_stream_error" } });
      } finally {
        controller.close();
      }
    },
  });
  ctx.set.headers["Content-Type"] = "text/event-stream";
  ctx.set.headers["Cache-Control"] = "no-cache";
  ctx.set.headers["Connection"] = "keep-alive";
  ctx.set.headers["X-Accel-Buffering"] = "no";
  return new Response(stream, { headers: ctx.set.headers as Record<string, string> });
});

// ── Saved conversations CRUD ─────────────────────────────────────────────────
playgroundRoutes.get("/conversations", (ctx) => {
  authGuard(ctx);
  ensureSchema();
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM playground_conversations ORDER BY updated_at DESC LIMIT 100"
  ).all() as Record<string, unknown>[];
  return {
    conversations: rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      model: r.model as string,
      messages: JSON.parse(r.messages as string),
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    })),
  };
});

playgroundRoutes.post("/conversations", (ctx) => {
  authGuard(ctx);
  ensureSchema();
  const body = (ctx.body ?? {}) as {
    id?: string;
    title?: string;
    model: string;
    messages: PlaygroundMessage[];
  };
  if (!body.model || !Array.isArray(body.messages)) {
    ctx.set.status = 400;
    return err("model and messages[] required", 400);
  }
  const db = getDb();
  const id = body.id ?? crypto.randomUUID();
  const now = Date.now();
  const title = body.title ?? body.messages[0]?.content?.slice(0, 60) ?? "Untitled";
  // Upsert
  const existing = db.prepare("SELECT id FROM playground_conversations WHERE id = ?").get(id);
  if (existing) {
    db.prepare(
      "UPDATE playground_conversations SET title = ?, model = ?, messages = ?, updated_at = ? WHERE id = ?"
    ).run(title, body.model, JSON.stringify(body.messages), now, id);
  } else {
    db.prepare(
      "INSERT INTO playground_conversations (id, title, model, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, title, body.model, JSON.stringify(body.messages), now, now);
  }
  return { ok: true, id, title };
});

playgroundRoutes.delete("/conversations/:id", (ctx) => {
  authGuard(ctx);
  ensureSchema();
  getDb().prepare("DELETE FROM playground_conversations WHERE id = ?").run(ctx.params.id);
  return { ok: true };
});
