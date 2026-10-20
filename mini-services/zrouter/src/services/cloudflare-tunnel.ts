/**
 * Cloudflare tunnel service — exposes the local gateway via a public URL
 * without opening any ports.
 *
 * Two modes:
 *   1. Quick tunnel (no token): `cloudflared tunnel --url http://localhost:PORT`
 *      → random *.trycloudflare.com URL
 *   2. Named tunnel (with token): `cloudflared tunnel run --token TOKEN`
 *      → uses Cloudflare Zero Trust, ingress configured remotely
 *
 * Auto-restart with exponential backoff (max 5 attempts, 30s cap).
 * Event emitter pub/sub for SSE status updates.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_RESTART_ATTEMPTS = 5;
const MAX_EVENT_LISTENERS = 8;

interface TunnelStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  domain?: string;
  error?: string;
  autostart: boolean;
  cloudflaredPath?: string;
  installState: "none" | "downloading" | "installed" | "error";
  installProgress?: { downloaded: number; total: number };
}

let status: TunnelStatus = {
  running: false,
  autostart: false,
  installState: "none",
};

let child: ChildProcess | null = null;
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

const tunnelEmitter = new EventEmitter();
tunnelEmitter.setMaxListeners(100);

let lastEmitAt = 0;
function emitUpdate(force = false): void {
  const now = Date.now();
  if (!force && now - lastEmitAt < 300) return;
  lastEmitAt = now;
  tunnelEmitter.emit("update", { ...status });
}

export function getTunnelStatus(): TunnelStatus {
  return { ...status };
}

export function onTunnelUpdate(handler: (s: TunnelStatus) => void): () => void {
  tunnelEmitter.on("update", handler);
  return () => tunnelEmitter.off("update", handler);
}

/** Find the cloudflared binary — checks PATH, then ~/.local/bin/. */
async function findCloudflared(): Promise<string | null> {
  // Check if cloudflared is in PATH
  const which = await new Promise<string | null>((resolve) => {
    const p = spawn("which", ["cloudflared"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out.trim() || null));
    p.on("error", () => resolve(null));
  });
  if (which && fs.existsSync(which)) return which;

  // Check ~/.local/bin/cloudflared
  const localBin = path.join(os.homedir(), ".local", "bin", "cloudflared");
  if (fs.existsSync(localBin)) return localBin;

  return null;
}

/** Start the tunnel. */
export async function startTunnel(opts?: {
  token?: string;
  domain?: string;
  port?: number;
}): Promise<{ ok: boolean; error?: string; domain?: string }> {
  if (status.running) {
    return { ok: false, error: "Tunnel is already running" };
  }

  const port = opts?.port ?? Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3000);
  const cloudflared = await findCloudflared();
  if (!cloudflared) {
    status = { ...status, error: "cloudflared binary not found. Install it first." };
    emitUpdate(true);
    return { ok: false, error: status.error };
  }

  status.cloudflaredPath = cloudflared;
  restartAttempts = 0;
  return await doStart(cloudflared, opts?.token, port);
}

async function doStart(
  cloudflared: string,
  token: string | undefined,
  port: number
): Promise<{ ok: boolean; error?: string; domain?: string }> {
  try {
    const args = token
      ? ["tunnel", "run", "--token", token]
      : ["tunnel", "--url", `http://localhost:${port}`];

    child = spawn(cloudflared, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });

    status = {
      ...status,
      running: true,
      pid: child.pid,
      startedAt: Date.now(),
      error: undefined,
    };
    emitUpdate(true);

    let foundDomain = false;

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      if (!foundDomain) {
        // Look for the trycloudflare.com URL
        const match = text.match(/https:\/\/[a-z0-9][^\s"'<>|]*\.(?:trycloudflare\.com|cfargotunnel\.com)/i);
        if (match) {
          status.domain = match[0];
          foundDomain = true;
          emitUpdate(true);
          console.log(`[tunnel] Public URL: ${status.domain}`);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      // Some cloudflared builds log to stderr
      if (!foundDomain) {
        const match = text.match(/https:\/\/[a-z0-9][^\s"'<>|]*\.(?:trycloudflare\.com|cfargotunnel\.com)/i);
        if (match) {
          status.domain = match[0];
          foundDomain = true;
          emitUpdate(true);
          console.log(`[tunnel] Public URL: ${status.domain}`);
        }
      }
    });

    child.on("exit", (code) => {
      status.running = false;
      status.pid = undefined;
      emitUpdate(true);

      if (code !== 0 && code !== null && restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts += 1;
        const delay = Math.min(1000 * 2 ** (restartAttempts - 1), 30_000);
        console.log(`[tunnel] exited (${code}), restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
        restartTimer = setTimeout(() => {
          doStart(cloudflared, token, port).catch((err) => {
            console.error(`[tunnel] restart failed:`, err);
          });
        }, delay);
      } else if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        status.error = "Max restart attempts reached. Manual restart required.";
        emitUpdate(true);
      }
    });

    child.on("error", (err) => {
      status.running = false;
      status.error = err.message;
      emitUpdate(true);
    });

    return { ok: true };
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    emitUpdate(true);
    return { ok: false, error: status.error };
  }
}

/** Stop the tunnel. */
export function stopTunnel(): { ok: boolean } {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  restartAttempts = MAX_RESTART_ATTEMPTS; // prevent auto-restart
  if (child) {
    try {
      child.kill("SIGTERM");
      // Force kill after 5s
      setTimeout(() => {
        if (child) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, 5000).unref();
    } catch {
      /* ignore */
    }
    child = null;
  }
  status = {
    ...status,
    running: false,
    pid: undefined,
    domain: undefined,
    error: undefined,
  };
  emitUpdate(true);
  return { ok: true };
}

/** Set autostart flag (persisted to settings). */
export function setAutostart(enabled: boolean): void {
  status.autostart = enabled;
  emitUpdate(true);
}

/** Auto-start tunnel on boot if enabled. */
export async function autostartIfEnabled(): Promise<void> {
  if (!status.autostart) return;
  // Read token from settings
  const { getSetting } = await import("./db");
  const token = getSetting("cloudflare_tunnel_token", "");
  const domain = getSetting("cloudflare_tunnel_domain", "");
  if (token || !getSetting("cloudflare_tunnel_autostart", "0") && !token) {
    if (getSetting("cloudflare_tunnel_autostart", "0") === "1" || token) {
      await startTunnel({ token: token || undefined, domain: domain || undefined });
    }
  }
}
