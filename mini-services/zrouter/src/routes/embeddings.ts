/**
 * /v1/embeddings — OpenAI-compatible embeddings endpoint.
 *
 * Routes the request to the same provider executors as chat completions.
 * Models use the `provider/model` format (e.g. `openai/text-embedding-3-small`).
 *
 * Most OpenAI-compatible providers (OpenAI, Together, Cohere, Voyage, etc.)
 * expose the same `/embeddings` endpoint, so we just call into the same
 * OpenAIExecutor with the embeddings URL.
 */

import { Elysia } from "elysia";
import * as registry from "../services/registry";
import { splitModelId } from "../services/registry";
import { authenticate } from "../middleware/auth";
import type { OpenAIExecutor } from "../executors/openai";

interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

function errPayload(message: string, status: number) {
  return {
    error: {
      message,
      type: status === 401 ? "authentication_error" : "invalid_request_error",
      code: null,
    },
  };
}

export const embeddingsRoutes = new Elysia();

embeddingsRoutes.post("/v1/embeddings", async (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return errPayload("Invalid or missing API key", 401);
  }

  const body = ctx.body as EmbeddingsRequest;
  if (!body || !body.model || body.input === undefined) {
    ctx.set.status = 400;
    return errPayload("Missing required fields: model, input", 400);
  }

  // Get the executor for this provider
  const { providerId, model } = splitModelId(body.model);
  const executor = registry.getExecutorInstance(providerId) as OpenAIExecutor | null;
  if (!executor) {
    ctx.set.status = 400;
    return errPayload(
      `No active provider for "${providerId}". Configure credentials in /admin.`,
      400
    );
  }

  // OpenAIExecutor's getHeaders is protected, so we re-fetch the credentials
  // to build auth headers ourselves
  const { findProviderDef } = await import("../providers/catalog");
  const { findProvider: findCred } = await import("../services/config-store");
  const def = findProviderDef(providerId);
  if (!def) {
    ctx.set.status = 400;
    return errPayload(`Unknown provider: ${providerId}`, 400);
  }

  const inputArr = Array.isArray(body.input) ? body.input : [body.input];
  const upstreamBody: Record<string, unknown> = {
    model,
    input: inputArr,
  };
  if (body.encoding_format) upstreamBody.encoding_format = body.encoding_format;
  if (body.dimensions) upstreamBody.dimensions = body.dimensions;

  // Use fetch directly with credentials from config store
  const cred = findCred(def.id);
  const baseUrl = (cred?.baseUrl ?? def.baseUrl).replace(/\/$/, "");
  let token = cred?.apiKey ?? "";
  try {
    const parsed = JSON.parse(token) as { accessToken?: string };
    if (parsed.accessToken) token = parsed.accessToken;
  } catch {
    // Plain API key
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "KRouter/1.0.0 (Bun)",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    if (token.startsWith("AIzaSy")) headers["x-goog-api-key"] = token;
  }

  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
    });
    if (!res.ok) {
      const text = await res.text();
      ctx.set.status = res.status;
      return errPayload(`${def.name} embeddings error (${res.status}): ${text}`, res.status);
    }
    const data = await res.json();
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.set.status = 502;
    return errPayload(msg, 502);
  }
});
