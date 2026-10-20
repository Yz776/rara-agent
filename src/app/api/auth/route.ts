// POST   /api/auth      — IP-based anonymous login (NO captcha, NO device verification)
// GET    /api/auth      — return current user info (token-bound IP check)
// PATCH  /api/auth      — revoke current session (logout)
//
// SECURITY LAYERS (simplified — no captcha, no device fingerprint):
//   1. Bot UA check (curl/wget/python-requests → 502)
//   2. Rate limit: 30 login attempts/hour per IP
//   3. 1 IP = 1 session: revoke all prior sessions for this IP before issuing new
//   4. Session bound to IP — verified on every subsequent request
//
// User identity is derived from IP (authId = sha256(ip + AUTH_SECRET)).
// Same IP → same authId → same user (sandbox, conversations, env preserved).
// Different IP → different user.

import { NextRequest, NextResponse } from 'next/server';
import {
  loginWithIp, verifyToken, revokeSession, bearerFromHeaders,
} from '@/lib/auth';
import { checkRateLimit, extractIp, isBotUserAgent } from '@/lib/anti-abuse';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── POST /api/auth ──────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const ip = extractIp(req.headers);
  const ua = req.headers.get('user-agent');

  // Bot UA check
  if (isBotUserAgent(ua)) {
    return new NextResponse('Bad Gateway', { status: 502 });
  }

  // Rate limit — fail-open if DB unavailable
  try {
    const rl = await checkRateLimit(ip, 'login_attempt');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many login attempts. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSec) },
        },
      );
    }
  } catch (e: any) {
    console.error('[auth] rate-limit check failed:', e?.message);
  }

  // Parse body (optional — body can be empty or {})
  let body: any = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    // Body is optional — empty body is fine. Just continue with body = {}.
  }

  // Optional: honeypot field — if filled, silently treat as bot
  // (kept as a soft check; bots that fill hidden form fields are blocked)
  if (body._hp && String(body._hp).trim().length > 0) {
    return NextResponse.json({ error: 'Verifikasi gagal.' }, { status: 403 });
  }

  // ── All checks passed — login (no captcha, no device verification) ─────
  // User identity is derived from the IP. The body is accepted but ignored
  // (compatibility with old clients that still send _fp, _bh, _ts — we no
  // longer require them).
  const auth = await loginWithIp({
    userAgent: ua || undefined,
    ip,
  });

  const user = await db.user.findUnique({ where: { id: auth.userId } });

  return NextResponse.json({
    token: auth.token,
    authId: auth.authId,
    userId: auth.userId,
    displayName: user?.displayName || null,
    createdAt: user?.createdAt?.toISOString(),
    expiresInDays: 30,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

// ── GET /api/auth ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const ip = extractIp(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const user = await db.user.findUnique({ where: { id: auth.userId } });
  if (!user) return NextResponse.json({ error: 'user not found' }, { status: 404 });
  return NextResponse.json({
    userId: user.id,
    authId: user.authId,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
  });
}

// ── PATCH /api/auth — logout ────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  const ip = extractIp(req.headers);
  const auth = await verifyToken(bearerFromHeaders(req.headers), ip);
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  await revokeSession(auth.token);
  return NextResponse.json({ ok: true });
}
