/**
 * Webhook notifications — fire HTTP POST callbacks to user-configured URLs
 * when interesting events happen in the gateway.
 *
 * Supported events:
 *   - quota.threshold      — virtual key crossed its quota/credit threshold
 *   - error.rate           — error rate exceeded N% over the last M minutes
 *   - oauth.connected      — an OAuth provider was connected
 *   - oauth.disconnected   — an OAuth provider was disconnected
 *   - key.created          — a new admin or virtual key was created
 *   - provider.failed      — a provider returned 5xx repeatedly
 *   - cache.hit_rate       — cache hit rate crossed a threshold
 *
 * Each webhook has: URL, secret (for HMAC-SHA256 signature), subscribed events,
 * optional per-event thresholds. Settings persisted in SQLite.
 *
 * Dispatch is fire-and-forget with a 5s timeout; failures are logged but don't
 * block the request that triggered them.
 */

import { getSetting, setSetting } from "./db";
import crypto from "node:crypto";

export type WebhookEvent =
  | "quota.threshold"
  | "error.rate"
  | "oauth.connected"
  | "oauth.disconnected"
  | "key.created"
  | "provider.failed"
  | "cache.hit_rate";

export const ALL_WEBHOOK_EVENTS: WebhookEvent[] = [
  "quota.threshold",
  "error.rate",
  "oauth.connected",
  "oauth.disconnected",
  "key.created",
  "provider.failed",
  "cache.hit_rate",
];

export interface WebhookConfig {
  id: string;
  url: string;
  secret?: string;
  events: WebhookEvent[];
  enabled: boolean;
  /** Per-event thresholds (e.g. { "quota.threshold": 0.8 } = warn at 80%). */
  thresholds?: Partial<Record<WebhookEvent, number>>;
  createdAt: number;
  lastFiredAt?: number;
  lastStatus?: number;
  lastError?: string;
}

interface WebhookSettings {
  webhooks: WebhookConfig[];
}

const SETTINGS_KEY = "webhook_settings";

let settingsCache: WebhookSettings | null = null;

function loadSettings(): WebhookSettings {
  if (settingsCache) return settingsCache;
  try {
    const raw = getSetting(SETTINGS_KEY, JSON.stringify({ webhooks: [] }));
    settingsCache = JSON.parse(raw) as WebhookSettings;
    if (!Array.isArray(settingsCache.webhooks)) settingsCache.webhooks = [];
  } catch {
    settingsCache = { webhooks: [] };
  }
  return settingsCache!;
}

function saveSettings(): void {
  if (!settingsCache) return;
  setSetting(SETTINGS_KEY, JSON.stringify(settingsCache));
}

export function listWebhooks(): WebhookConfig[] {
  return loadSettings().webhooks.map((w) => ({ ...w }));
}

export function getWebhook(id: string): WebhookConfig | undefined {
  return loadSettings().webhooks.find((w) => w.id === id);
}

export function createWebhook(opts: {
  url: string;
  secret?: string;
  events: WebhookEvent[];
  enabled?: boolean;
  thresholds?: Partial<Record<WebhookEvent, number>>;
}): WebhookConfig {
  const settings = loadSettings();
  const webhook: WebhookConfig = {
    id: crypto.randomUUID(),
    url: opts.url,
    secret: opts.secret,
    events: opts.events,
    enabled: opts.enabled ?? true,
    thresholds: opts.thresholds,
    createdAt: Date.now(),
  };
  settings.webhooks.push(webhook);
  saveSettings();
  return webhook;
}

export function updateWebhook(id: string, updates: Partial<Omit<WebhookConfig, "id" | "createdAt">>): WebhookConfig | undefined {
  const settings = loadSettings();
  const webhook = settings.webhooks.find((w) => w.id === id);
  if (!webhook) return undefined;
  Object.assign(webhook, updates);
  saveSettings();
  return webhook;
}

export function deleteWebhook(id: string): boolean {
  const settings = loadSettings();
  const before = settings.webhooks.length;
  settings.webhooks = settings.webhooks.filter((w) => w.id !== id);
  if (settings.webhooks.length === before) return false;
  saveSettings();
  return true;
}

/** Test-fire a webhook with a dummy payload. */
export async function testWebhook(id: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const webhook = getWebhook(id);
  if (!webhook) return { ok: false, error: "Webhook not found" };
  return dispatch(webhook, {
    event: "test" as WebhookEvent,
    message: "This is a test webhook from KRouter",
    timestamp: Date.now(),
  });
}

/**
 * Fire an event to all subscribed webhooks. Non-blocking — returns immediately
 * after dispatching (each dispatch has its own 5s timeout).
 */
export function fireEvent(event: WebhookEvent, payload: Record<string, unknown>): void {
  const settings = loadSettings();
  for (const webhook of settings.webhooks) {
    if (!webhook.enabled) continue;
    if (!webhook.events.includes(event)) continue;
    // Check per-event threshold if configured
    const threshold = webhook.thresholds?.[event];
    if (threshold !== undefined && typeof payload.value === "number" && payload.value < threshold) {
      continue;
    }
    // Fire-and-forget
    dispatch(webhook, { event, ...payload, timestamp: Date.now() }).catch(() => {
      // swallow — webhook failures should never break the gateway
    });
  }
}

async function dispatch(
  webhook: WebhookConfig,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "KRouter-Webhook/2.0",
  };
  if (webhook.secret) {
    const sig = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
    headers["X-KRouter-Signature"] = `sha256=${sig}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    // Update last-fire stats
    webhook.lastFiredAt = Date.now();
    webhook.lastStatus = res.status;
    webhook.lastError = res.ok ? undefined : `HTTP ${res.status}`;
    saveSettings();
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    webhook.lastFiredAt = Date.now();
    webhook.lastError = msg;
    saveSettings();
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}
