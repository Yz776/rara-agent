/**
 * /admin/api/tunnel — Cloudflare tunnel management routes.
 *
 *   GET  /tunnel/status              — running state, pid, domain
 *   GET  /tunnel/events              — SSE stream of status updates (25s heartbeat)
 *   POST /tunnel/start                — start tunnel (body: {token?, domain?})
 *   POST /tunnel/stop                 — stop tunnel
 *   PATCH /tunnel                    — update config (token, domain, autostart)
 */

import { Elysia } from "elysia";
import {
  getTunnelStatus,
  onTunnelUpdate,
  startTunnel,
  stopTunnel,
  setAutostart,
} from "../services/cloudflare-tunnel";
import { getSetting, setSetting } from "../services/db";
import { authenticate } from "../middleware/auth";

function err(message: string) {
  return { error: { message, type: "tunnel_error" } };
}

export const tunnelRoutes = new Elysia({ prefix: "/admin/api/tunnel" });

tunnelRoutes.get("/status", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  return getTunnelStatus();
});

tunnelRoutes.get("/events", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (s: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(s));
      };

      // Send initial state
      send(`data: ${JSON.stringify(getTunnelStatus())}\n\n`);

      const handler = (s: unknown) => {
        send(`data: ${JSON.stringify(s)}\n\n`);
      };
      const unsubscribe = onTunnelUpdate(handler);

      // Heartbeat every 25s
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);

      // Cleanup when client disconnects
      ctx.request.signal?.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch {}
      });

      // Also cleanup after 1h max
      setTimeout(() => {
        if (!closed) {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try { controller.close(); } catch {}
        }
      }, 60 * 60 * 1000).unref();
    },
  });

  ctx.set.headers["Content-Type"] = "text/event-stream";
  ctx.set.headers["Cache-Control"] = "no-cache";
  ctx.set.headers["Connection"] = "keep-alive";
  return new Response(stream, { headers: ctx.set.headers as Record<string, string> });
});

tunnelRoutes.post("/start", async (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  const body = (ctx.body ?? {}) as { token?: string; domain?: string };
  // Persist token if provided
  if (body.token) {
    setSetting("cloudflare_tunnel_token", body.token);
  }
  if (body.domain) {
    setSetting("cloudflare_tunnel_domain", body.domain);
  }
  const token = body.token || getSetting("cloudflare_tunnel_token", "");
  const result = await startTunnel({
    token: token || undefined,
    domain: body.domain,
    port: Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000),
  });
  return result;
});

tunnelRoutes.post("/stop", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  return stopTunnel();
});

tunnelRoutes.patch("/", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  const body = (ctx.body ?? {}) as {
    token?: string;
    domain?: string;
    autostart?: boolean;
  };
  if (typeof body.token === "string") setSetting("cloudflare_tunnel_token", body.token);
  if (typeof body.domain === "string") setSetting("cloudflare_tunnel_domain", body.domain);
  if (typeof body.autostart === "boolean") {
    setSetting("cloudflare_tunnel_autostart", body.autostart ? "1" : "0");
    setAutostart(body.autostart);
  }
  return { ok: true };
});
