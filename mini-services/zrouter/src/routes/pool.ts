/**
 * /admin/api/pool — admin REST API for the unified upstream API-key pool.
 *
 * Endpoints (all require `isAdmin`):
 *   GET    /admin/api/pool[?providerId=openai]   List entries
 *   POST   /admin/api/pool                       Create entry
 *   PATCH  /admin/api/pool/:id                   Update entry
 *   DELETE /admin/api/pool/:id                   Delete entry
 *   POST   /admin/api/pool/:id/reset-cooldown    Manually revive an entry
 *   GET    /admin/api/pool/stats                 Per-provider summary
 */

import { Elysia } from "elysia";
import { isAdmin } from "../middleware/auth";
import * as poolSvc from "../services/key-pool";

function err(message: string, status: number) {
  return { error: { message, type: "admin_error", status } };
}

function ensureAdmin(ctx: { request: Request; set: { status?: number } }): Response | null {
  if (!isAdmin({ request: ctx.request } as never)) {
    return new Response(JSON.stringify(err("Unauthorized — admin access required", 403)), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export const poolRoutes = new Elysia({ prefix: "/admin/api/pool" });

poolRoutes.get("/", (ctx) => {
  const deny = ensureAdmin(ctx);
  if (deny) return deny;
  const providerId = (ctx.query as { providerId?: string }).providerId;
  const entries = poolSvc.listEntries(providerId).map((e) => ({
    ...e,
    apiKey: e.apiKey ? maskKey(e.apiKey) : "",
  }));
  return { entries };
});

poolRoutes.get("/stats", (ctx) => {
  const deny = ensureAdmin(ctx);
  if (deny) return deny;
  return { stats: poolSvc.poolStats() };
});

poolRoutes.post("/", (ctx) => {
  const deny = ensureAdmin(ctx);
  if (deny) return deny;
  const body = (ctx.body ?? {}) as {
    label?: string;
    providerId?: string;
    apiKey?: string;
    baseUrl?: string;
    proxyUrl?: string;
    enabled?: boolean;
    weight?: number;
  };
  if (!body.providerId || !body.apiKey || !body.label) {
    ctx.set.status = 400;
    return err("label, providerId, apiKey are required", 400);
  }
  if (body.proxyUrl && !/^https?:\/\//.test(body.proxyUrl) && !/^socks[45]:\/\//.test(body.proxyUrl)) {
    ctx.set.status = 400;
    return err("proxyUrl must start with http://, https://, socks4://, or socks5://", 400);
  }
  try {
    const entry = poolSvc.createEntry({
      label: body.label,
      providerId: body.providerId,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      proxyUrl: body.proxyUrl,
      enabled: body.enabled,
      weight: body.weight,
    });
    return { ok: true, entry: { ...entry, apiKey: maskKey(entry.apiKey) } };
  } catch (e) {
    ctx.set.status = 400;
    return err(e instanceof Error ? e.message : String(e), 400);
  }
});

poolRoutes.patch("/:id", (ctx) => {
  const deny = ensureAdmin(ctx);
  if (deny) return deny;
  const id = ctx.params.id;
  const body = (ctx.body ?? {}) as Partial<{
    label: string;
    apiKey: string;
    baseUrl: string;
    proxyUrl: string;
    enabled: boolean;
    weight: number;
  }>;
  const updated = poolSvc.updateEntry(id, body);
  if (!updated) {
    ctx.set.status = 404;
    return err("Pool entry not found", 404);
  }
  return { ok: true, entry: { ...updated, apiKey: maskKey(updated.apiKey) } };
});

poolRoutes.delete("/:id", (ctx) => {
  const deny = ensureAdmin(ctx);
  if (deny) return deny;
  poolSvc.deleteEntry(ctx.params.id);
  return { ok: true };
});

poolRoutes.post("/:id/reset-cooldown", (ctx) => {
  const deny = ensureAdmin(ctx);
  if (deny) return deny;
  poolSvc.resetCooldown(ctx.params.id);
  return { ok: true };
});

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 12) return k.slice(0, 2) + "…";
  return k.slice(0, 6) + "…" + k.slice(-4);
}
