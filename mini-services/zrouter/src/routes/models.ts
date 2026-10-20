/**
 * /v1/models — OpenAI-compatible model list endpoint.
 *
 * Aggregates models from every enabled provider (config-store credential
 * OR pool entry). Each model id is `provider/model` so callers can target
 * a specific upstream.
 *
 * Auth:
 *  - Authenticated callers see every model.
 *  - Anonymous callers see models per the public-access policy:
 *      models='all'  → all models (admin pays upstream)
 *      models='free' → only free-tier models
 *    When public_access is disabled entirely, anonymous callers get 401.
 */

import { Elysia } from "elysia";
import * as registry from "../services/registry";
import { authenticate } from "../middleware/auth";
import {
  getPublicAccessSettings,
  isFreeModel,
} from "../services/public-access";

function errPayload(message: string, status: number) {
  return {
    error: { message, type: "authentication_error", code: null },
  };
}

export const modelsRoutes = new Elysia();

async function listFor(ctx: { request: Request }) {
  const models = await registry.listAllModels();
  const all = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: m.created ?? Math.floor(Date.now() / 1000),
    owned_by: m.owned_by,
  }));
  const pub = getPublicAccessSettings();
  if (!authenticate(ctx as never) && pub.enabled) {
    if (pub.models === "all") {
      return { object: "list" as const, data: all };
    }
    return { object: "list" as const, data: all.filter((m) => isFreeModel(m.id)) };
  }
  return { object: "list" as const, data: all };
}

modelsRoutes.get("/v1/models", async (ctx) => {
  if (!authenticate(ctx) && !getPublicAccessSettings().enabled) {
    ctx.set.status = 401;
    return errPayload("Invalid or missing API key. Generate one at /admin or enable Public Access.", 401);
  }
  return await listFor(ctx);
});

// Also expose /models for agents that strip the /v1 prefix
modelsRoutes.get("/models", async (ctx) => {
  if (!authenticate(ctx) && !getPublicAccessSettings().enabled) {
    ctx.set.status = 401;
    return errPayload("Invalid or missing API key. Generate one at /admin or enable Public Access.", 401);
  }
  return await listFor(ctx);
});
