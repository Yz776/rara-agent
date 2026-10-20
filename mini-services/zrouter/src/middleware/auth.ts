/**
 * Auth middleware — session-based + admin API key + shared internal token.
 *
 * After the virtual key removal, the gateway recognises these identities:
 *  - Admin API keys (`kr-...`) created via /admin — usable from CLI clients
 *    against /v1/* AND from automation against /admin/api/*.
 *  - Session cookie from username/password login via /api/auth/login.
 *  - KROUTER_INTERNAL_TOKEN env var — a shared secret used by trusted
 *    co-hosted services (e.g. the Rara Next.js app) to call the gateway
 *    over localhost without needing a separately-issued kr-... key. This
 *    lets the Next.js server-side fetch hit /v1/* and /admin/api/* as an
 *    admin. The token is never exposed to the browser.
 *
 * Bootstrap mode: when no admin keys exist yet (first run), requests are
 * allowed through so the dashboard bootstrap flow can create one.
 *
 * Anonymous free access (per-IP rate limited) is granted separately by the
 * chat / models routes when `public_free_access.enabled` is on — those
 * callers do NOT go through this middleware; they just hit the public
 * branch in chat.ts / models.ts.
 */

import type { Context } from "elysia";
import * as store from "../services/config-store";
import { validateSession, findUserById } from "../services/auth-user";

const INTERNAL_TOKEN = process.env.KROUTER_INTERNAL_TOKEN || "";

function isInternalToken(token: string): boolean {
  if (!INTERNAL_TOKEN || !token) return false;
  // Constant-time compare so timing attacks can't brute-force the secret.
  if (token.length !== INTERNAL_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ INTERNAL_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

export function authenticate(ctx: Context): boolean {
  // Bootstrap mode: only when there are no admin keys AND no internal token
  // env var configured. When KROUTER_INTERNAL_TOKEN is set, the gateway is
  // considered "managed" — bootstrap mode is skipped so only callers with
  // the shared secret (or a separately-issued admin key) can authenticate.
  if (!INTERNAL_TOKEN && store.listAdminKeys().length === 0) return true;

  const auth = ctx.request.headers.get("authorization") ?? "";
  const xApiKey = ctx.request.headers.get("x-api-key") ?? "";
  const tokenHeader =
    (auth.startsWith("Bearer ") ? auth.slice(7) : auth) || xApiKey;

  // Header-based admin key (config.json) OR shared internal token (env).
  if (tokenHeader) {
    if (store.findAdminKey(tokenHeader)) return true;
    if (isInternalToken(tokenHeader)) return true;
    return false;
  }

  // Fall back to session cookie (username/password login)
  const cookieHeader = ctx.request.headers.get("cookie");
  if (cookieHeader) {
    const cookieValue = cookieHeader.split(";").find(c => c.trim().startsWith("kr_session="));
    if (cookieValue) {
      const sessionToken = cookieValue.split("=")[1];
      if (sessionToken && validateSession(sessionToken)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Admin-only check. Used to gate /admin/api/* — only admin API keys,
 * the shared internal token, and admin-role session users pass.
 */
export function isAdmin(ctx: Context): boolean {
  // Bootstrap mode: only when no admin keys AND no internal token env.
  if (!INTERNAL_TOKEN && store.listAdminKeys().length === 0) return true;

  const auth = ctx.request.headers.get("authorization") ?? "";
  const xApiKey = ctx.request.headers.get("x-api-key") ?? "";
  const tokenHeader =
    (auth.startsWith("Bearer ") ? auth.slice(7) : auth) || xApiKey;

  if (tokenHeader) {
    if (store.findAdminKey(tokenHeader)) return true;
    if (isInternalToken(tokenHeader)) return true;
    return false;
  }

  // Session-cookie path — only admin role passes
  const cookieHeader = ctx.request.headers.get("cookie");
  if (cookieHeader) {
    const cookieValue = cookieHeader.split(";").find(c => c.trim().startsWith("kr_session="));
    if (cookieValue) {
      const sessionToken = cookieValue.split("=")[1];
      if (sessionToken) {
        const session = validateSession(sessionToken);
        if (session) {
          const user = findUserById(session.userId);
          return Boolean(user && user.role === "admin");
        }
      }
    }
  }

  return false;
}

export function isSessionAdmin(ctx: Context): boolean {
  return isAdmin(ctx);
}
