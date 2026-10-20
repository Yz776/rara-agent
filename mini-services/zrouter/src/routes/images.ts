/**
 * /v1/images/generations — OpenAI-compatible image generation endpoint.
 *
 * Routes to providers that support image generation. The request uses the
 * standard OpenAI DALL-E API shape, so any AI agent that uses image gen
 * (Codex, Cursor's image features, etc.) can target this gateway.
 *
 * Currently supports OpenAI (DALL-E), Together (Stable Diffusion),
 * Fal.ai, Stability AI — any OpenAI-compatible image gen endpoint.
 */

import { Elysia } from "elysia";
import * as registry from "../services/registry";
import { splitModelId } from "../services/registry";
import { authenticate } from "../middleware/auth";

interface ImageGenRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  response_format?: "url" | "b64_json";
  user?: string;
  // Provider-specific pass-through
  [key: string]: unknown;
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

export const imageRoutes = new Elysia();

imageRoutes.post("/v1/images/generations", async (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return errPayload("Invalid or missing API key", 401);
  }

  const body = ctx.body as ImageGenRequest;
  if (!body || !body.model || !body.prompt) {
    ctx.set.status = 400;
    return errPayload("Missing required fields: model, prompt", 400);
  }

  const { providerId, model } = splitModelId(body.model);
  const executor = registry.getExecutorInstance(providerId);
  if (!executor) {
    ctx.set.status = 400;
    return errPayload(
      `No active provider for "${providerId}". Configure credentials in /admin.`,
      400
    );
  }

  // Fetch credentials and baseUrl from the config store
  const { findProviderDef } = await import("../providers/catalog");
  const { findProvider: findCred } = await import("../services/config-store");
  const def = findProviderDef(providerId);
  if (!def) {
    ctx.set.status = 400;
    return errPayload(`Unknown provider: ${providerId}`, 400);
  }
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

  const upstreamBody: Record<string, unknown> = {
    model,
    prompt: body.prompt,
    n: body.n ?? 1,
    size: body.size ?? "1024x1024",
    response_format: body.response_format ?? "b64_json",
  };
  if (body.quality) upstreamBody.quality = body.quality;
  if (body.style) upstreamBody.style = body.style;

  try {
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
    });
    if (!res.ok) {
      const text = await res.text();
      ctx.set.status = res.status;
      return errPayload(`${def.name} image gen error (${res.status}): ${text}`, res.status);
    }
    const data = await res.json();
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.set.status = 502;
    return errPayload(msg, 502);
  }
});
