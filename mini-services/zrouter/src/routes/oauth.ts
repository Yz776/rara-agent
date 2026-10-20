/**
 * OAuth callback routes — handles the redirect from OAuth providers
 * (Claude, Codex, Antigravity, Gemini CLI) back to the gateway.
 *
 * Flow:
 *   1. Dashboard calls POST /admin/oauth/connect/:providerId → returns authorize URL
 *   2. User opens the URL → provider asks for consent → redirects to /admin/oauth/callback?code=...&state=...
 *   3. We look up the session by state, exchange the code for tokens, persist them
 *   4. Redirect back to the dashboard with a success/failure toast
 */

import { Elysia } from "elysia";
import {
  buildAuthorizeUrl,
  consumeOAuthSession,
  exchangeCodeForTokens,
  OAUTH_CONFIGS,
} from "../services/oauth";
import * as store from "../services/config-store";
import * as registry from "../services/registry";
import { authenticate } from "../middleware/auth";

function err(message: string) {
  return { error: { message, type: "oauth_error" } };
}

export const oauthRoutes = new Elysia();

// ── List supported OAuth providers ──────────────────────────────────────────
oauthRoutes.get("/admin/oauth/providers", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  return {
    providers: Object.keys(OAUTH_CONFIGS).map((id) => ({
      id,
      authorizeUrl: OAUTH_CONFIGS[id]!.authorizeUrl,
      scopes: OAUTH_CONFIGS[id]!.scopes,
    })),
  };
});

// ── Start OAuth flow: build authorize URL + save session ───────────────────
oauthRoutes.post("/admin/oauth/connect/:providerId", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  const providerId = ctx.params.providerId;
  const result = buildAuthorizeUrl(providerId);
  if ("error" in result) {
    ctx.set.status = 400;
    return err(result.error);
  }
  return { url: result.url, state: result.session.state };
});

// ── OAuth callback — provider redirects here with code+state ───────────────
oauthRoutes.get("/admin/oauth/callback", async (ctx) => {
  const code = ctx.query.code as string | undefined;
  const state = ctx.query.state as string | undefined;
  const error = ctx.query.error as string | undefined;

  if (error) {
    return new Response(
      `<!doctype html><body><script>opener?.postMessage({type:'oauth-error',error:${JSON.stringify(error)}},'*');setTimeout(()=>close(),2000);</script><p>OAuth error: ${error}</p></body>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }
  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const session = consumeOAuthSession(state);
  if (!session) {
    return new Response("Invalid or expired OAuth session", { status: 400 });
  }

  const result = await exchangeCodeForTokens(
    session.providerId,
    code,
    session.codeVerifier
  );

  if ("error" in result) {
    return new Response(
      `<!doctype html><body><script>opener?.postMessage({type:'oauth-error',error:${JSON.stringify(result.error)}},'*');setTimeout(()=>close(),2000);</script><p>OAuth error: ${result.error}</p></body>`,
      { headers: { "Content-Type": "text/html" } }
    );
  }

  // Persist as the provider's apiKey (JSON-encoded OAuthCredentials)
  store.upsertProvider({
    id: session.providerId,
    apiKey: JSON.stringify(result),
    enabled: true,
  });
  registry.invalidate(session.providerId);

  return new Response(
    `<!doctype html><body><script>opener?.postMessage({type:'oauth-success',provider:${JSON.stringify(session.providerId)}},'*');setTimeout(()=>close(),2000);</script><p>Connected! You can close this tab.</p></body>`,
    { headers: { "Content-Type": "text/html" } }
  );
});

// ── Disconnect: clear stored OAuth credentials ──────────────────────────────
oauthRoutes.delete("/admin/oauth/disconnect/:providerId", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  const providerId = ctx.params.providerId;
  store.deleteProvider(providerId);
  registry.invalidate(providerId);
  return { ok: true };
});

// ── Check OAuth connection status ──────────────────────────────────────────
oauthRoutes.get("/admin/oauth/status/:providerId", (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return err("Unauthorized");
  }
  const providerId = ctx.params.providerId;
  const cred = store.findProvider(providerId);
  if (!cred || !cred.apiKey) {
    return { connected: false };
  }
  try {
    const creds = JSON.parse(cred.apiKey) as {
      accessToken?: string;
      expiresAt?: number;
      accountId?: string;
    };
    const expired = creds.expiresAt ? Date.now() > creds.expiresAt : false;
    return {
      connected: true,
      accountId: creds.accountId,
      expiresAt: creds.expiresAt,
      expired,
    };
  } catch {
    return { connected: true, note: "Stored as plain API key (not OAuth)" };
  }
});
