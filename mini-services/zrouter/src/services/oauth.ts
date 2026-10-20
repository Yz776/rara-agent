/**
 * OAuth providers — Claude, Codex (OpenAI), Antigravity (Google), Gemini CLI.
 *
 * These providers authenticate via OAuth 2.0 Authorization Code with PKCE
 * instead of long-lived API keys. The gateway stores access + refresh tokens
 * and refreshes them automatically before they expire.
 *
 * OAuth flow:
 *   1. User clicks "Connect" in dashboard → we generate PKCE verifier+challenge
 *   2. User is redirected to the provider's authorize URL
 *   3. Provider redirects back to /admin/oauth/callback?code=...
 *   4. We exchange code+verifier for {access_token, refresh_token, expires_at}
 *   5. We persist them and use the access_token as the bearer for chat requests
 *
 * Refresh profiles (per provider):
 *   - claude:        JSON body, client_id only, 4h refresh lead
 *   - codex:          form-encoded, client_id only, 5d refresh lead, 8d max refresh age
 *   - antigravity:    form-encoded, client_id + client_secret (Google), 5m lead
 *   - gemini-cli:     same as antigravity but different client_id
 */

import crypto from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
  /** "json" or "form" — body encoding for refresh token request */
  refreshEncoding?: "json" | "form";
  /** How long before expiry to refresh (ms). */
  refreshLeadMs: number;
  /** Max age of refresh token before forcing re-auth (ms). */
  maxRefreshAgeMs?: number;
  /** Extra params to include in authorize URL. */
  extraAuthorizeParams?: Record<string, string>;
  /** Extra params to include in token exchange body. */
  extraTokenParams?: Record<string, string>;
}

export interface OAuthSession {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  providerId: string;
  createdAt: number;
}

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  lastRefreshedAt: number;
  accountId?: string;
  providerSpecificData?: Record<string, unknown>;
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

export function generatePKCE(): {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
} {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge, state };
}

// ── In-memory OAuth session storage (state → session) ────────────────────────
// In production you'd persist this to SQLite; for now in-memory is fine.

const sessions = new Map<string, OAuthSession>();

export function saveOAuthSession(session: OAuthSession): void {
  sessions.set(session.state, session);
  // Auto-expire after 10 minutes
  setTimeout(() => sessions.delete(session.state), 10 * 60 * 1000).unref?.();
}

export function consumeOAuthSession(state: string): OAuthSession | undefined {
  const session = sessions.get(state);
  if (session) sessions.delete(state);
  return session;
}

// ── Per-provider OAuth configs ────────────────────────────────────────────────

const REDIRECT_URI = `http://localhost:3000/admin/oauth/callback`;

export const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  // ── Claude (Anthropic) ────────────────────────────────────────────────────
  // Public Claude Code CLI client id — works for any local install
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    redirectUri: REDIRECT_URI,
    refreshEncoding: "json",
    refreshLeadMs: 4 * 60 * 60 * 1000, // 4 hours
    extraAuthorizeParams: { code_challenge_method: "S256" },
  },

  // ── Codex (OpenAI) ──────────────────────────────────────────────────────────
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email", "offline_access"],
    redirectUri: REDIRECT_URI,
    refreshEncoding: "form",
    refreshLeadMs: 5 * 24 * 60 * 60 * 1000, // 5 days
    maxRefreshAgeMs: 8 * 24 * 60 * 60 * 1000, // 8 days max
    extraAuthorizeParams: {
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
  },

  // ── Antigravity (Google) ──────────────────────────────────────────────────
  // Public Antigravity client id + secret (embedded in the Antigravity IDE)
  antigravity: {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    redirectUri: REDIRECT_URI,
    refreshEncoding: "form",
    refreshLeadMs: 5 * 60 * 1000, // 5 minutes
    extraAuthorizeParams: {
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    },
  },

  // ── Gemini CLI (Google) ─────────────────────────────────────────────────────
  // Public Gemini CLI client id — also Google OAuth
  "gemini-cli": {
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    redirectUri: REDIRECT_URI,
    refreshEncoding: "form",
    refreshLeadMs: 5 * 60 * 1000,
    extraAuthorizeParams: {
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    },
  },

  // ── GitHub Copilot ─────────────────────────────────────────────────────────
  github: {
    clientId: "Iv1.b5a3b8b2b5a3b8b2",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["read:user"],
    redirectUri: REDIRECT_URI,
    refreshEncoding: "json",
    refreshLeadMs: 5 * 60 * 1000,
    extraAuthorizeParams: {},
  },
};

/** Build the full authorize URL with PKCE challenge + state. */
export function buildAuthorizeUrl(providerId: string): { url: string; session: OAuthSession } | { error: string } {
  const cfg = OAUTH_CONFIGS[providerId];
  if (!cfg) return { error: `Unknown OAuth provider: ${providerId}` };

  const { codeVerifier, codeChallenge, state } = generatePKCE();
  const session: OAuthSession = {
    state,
    codeVerifier,
    codeChallenge,
    providerId,
    createdAt: Date.now(),
  };
  saveOAuthSession(session);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    ...(cfg.extraAuthorizeParams ?? {}),
  });

  return {
    url: `${cfg.authorizeUrl}?${params.toString()}`,
    session,
  };
}

/** Exchange the authorization code for tokens. */
export async function exchangeCodeForTokens(
  providerId: string,
  code: string,
  codeVerifier: string
): Promise<OAuthCredentials | { error: string }> {
  const cfg = OAUTH_CONFIGS[providerId];
  if (!cfg) return { error: `Unknown OAuth provider: ${providerId}` };

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: codeVerifier,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
    ...(cfg.extraTokenParams ?? {}),
  };

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  let bodyStr: string;
  if (cfg.refreshEncoding === "form") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    bodyStr = new URLSearchParams(body).toString();
  } else {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }

  try {
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      // Some providers return form-encoded
      json = Object.fromEntries(new URLSearchParams(text));
    }
    if (!res.ok) {
      return { error: `OAuth exchange failed (${res.status}): ${JSON.stringify(json)}` };
    }
    const accessToken = json.access_token as string;
    const refreshToken = json.refresh_token as string;
    const expiresIn = Number(json.expires_in ?? 3600);
    const now = Date.now();

    // Try to extract account id from id_token JWT (codex)
    let accountId: string | undefined;
    if (json.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from((json.id_token as string).split(".")[1]!, "base64").toString("utf8")
        ) as { sub?: string; email?: string };
        accountId = payload.sub ?? payload.email;
      } catch {
        /* ignore */
      }
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: now + expiresIn * 1000,
      lastRefreshedAt: now,
      accountId,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Refresh an expired access token using the refresh token. */
export async function refreshTokens(
  providerId: string,
  refreshToken: string
): Promise<OAuthCredentials | { error: string }> {
  const cfg = OAUTH_CONFIGS[providerId];
  if (!cfg) return { error: `Unknown OAuth provider: ${providerId}` };

  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
  };

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  let bodyStr: string;
  if (cfg.refreshEncoding === "form") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    bodyStr = new URLSearchParams(body).toString();
  } else {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }

  try {
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers,
      body: bodyStr,
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      json = Object.fromEntries(new URLSearchParams(text));
    }
    if (!res.ok) {
      // If refresh_token is invalid/expired, mark as permanent error
      const errType = (json.error as string) ?? "";
      const permanent = ["invalid_grant", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]
        .includes(errType);
      return {
        error: permanent
          ? `Refresh token is invalid or expired (${errType}). Re-authenticate at /admin.`
          : `Refresh failed (${res.status}): ${errType || text}`,
      };
    }
    const accessToken = json.access_token as string;
    const newRefreshToken = (json.refresh_token as string) ?? refreshToken;
    const expiresIn = Number(json.expires_in ?? 3600);
    const now = Date.now();

    let accountId: string | undefined;
    if (json.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from((json.id_token as string).split(".")[1]!, "base64").toString("utf8")
        ) as { sub?: string; email?: string };
        accountId = payload.sub ?? payload.email;
      } catch {
        /* ignore */
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt: now + expiresIn * 1000,
      lastRefreshedAt: now,
      accountId,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Check if credentials are due for a refresh. */
export function isDueForRefresh(creds: OAuthCredentials, providerId: string): boolean {
  const cfg = OAUTH_CONFIGS[providerId];
  if (!cfg) return false;
  const now = Date.now();
  // Refresh if expiry is within refreshLeadMs, or if token expired, or if never refreshed in 12h
  if (creds.expiresAt - now < cfg.refreshLeadMs) return true;
  if (now - creds.lastRefreshedAt > 12 * 60 * 60 * 1000) return true;
  // Codex: refresh if older than maxRefreshAgeMs
  if (cfg.maxRefreshAgeMs && now - creds.lastRefreshedAt > cfg.maxRefreshAgeMs) return true;
  return false;
}

/** Check if the codex refresh token is stale (older than maxRefreshAgeMs). */
export function isCodexRefreshStale(creds: OAuthCredentials, providerId: string): boolean {
  if (providerId !== "codex") return false;
  const cfg = OAUTH_CONFIGS["codex"]!;
  return cfg.maxRefreshAgeMs !== undefined && Date.now() - creds.lastRefreshedAt > cfg.maxRefreshAgeMs;
}
