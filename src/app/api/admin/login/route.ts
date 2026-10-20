// POST /api/admin/login — validate username+password, return admin key
//
// Replaces the "ask user for X-Admin-Key" flow on the /admin page.
// The admin now logs in with username + password (validated against env vars
// KROUTER_ADMIN_USERNAME + KROUTER_ADMIN_PASSWORD). On success, the server
// returns the KF_AI_ADMIN_KEY which the UI stores in localStorage and uses
// as X-Admin-Key header for subsequent /api/admin/* calls.
//
// Rate limited: 10 login attempts / hour per IP (fail-open if DB unavailable).

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, extractIp, isBotUserAgent } from '@/lib/anti-abuse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ADMIN_USERNAME = process.env.KROUTER_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.KROUTER_ADMIN_PASSWORD || '';
const ADMIN_KEY = process.env.KF_AI_ADMIN_KEY || '';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function POST(req: NextRequest) {
  const ip = extractIp(req.headers);
  const ua = req.headers.get('user-agent');

  // Bot UA check (same gate as /api/auth)
  if (isBotUserAgent(ua)) {
    return new NextResponse('Bad Gateway', { status: 502 });
  }

  // Rate limit admin login attempts — fail-open if DB unavailable
  try {
    const rl = await checkRateLimit(ip, 'admin');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many admin login attempts. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(rl.retryAfterSec) },
        },
      );
    }
  } catch {
    /* fail open */
  }

  // Parse body
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  // Validate
  if (!username || !password) {
    return NextResponse.json({ error: 'Username dan password wajib diisi.' }, { status: 400 });
  }

  // Constant-time comparison
  const usernameOk = timingSafeEqual(username, ADMIN_USERNAME);
  const passwordOk = ADMIN_PASSWORD && timingSafeEqual(password, ADMIN_PASSWORD);
  if (!usernameOk || !passwordOk) {
    // Don't reveal which one was wrong
    return NextResponse.json({ error: 'Username atau password salah.' }, { status: 401 });
  }

  // No admin key configured
  if (!ADMIN_KEY) {
    return NextResponse.json(
      { error: 'Admin panel belum dikonfigurasi. Set KF_AI_ADMIN_KEY di .env server.' },
      { status: 503 },
    );
  }

  // Success — return the admin key. The browser stores it in localStorage and
  // sends it as X-Admin-Key for all subsequent /api/admin/* calls. This is the
  // same trust model as before (admin key in localStorage); we just gate the
  // *retrieval* of the key behind a username+password check.
  return NextResponse.json(
    {
      ok: true,
      adminKey: ADMIN_KEY,
      username: ADMIN_USERNAME,
      message: 'Login berhasil. Admin key diaktifkan untuk sesi ini.',
    },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
