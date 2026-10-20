// POST /api/auth — NO verification, just issue token
// GET /api/auth — return current user (skip IP check)
// PATCH /api/auth — logout

import { NextRequest, NextResponse } from 'next/server';
import { loginWithDevice, verifyToken, revokeSession, bearerFromHeaders } from '@/lib/auth';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST — issue token immediately, no fingerprint/captcha/rate-limit
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const ua = req.headers.get('user-agent') || 'unknown';
  const auth = await loginWithDevice({
    userAgent: ua,
    ip,
    deviceFingerprint: 'anon-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    behavioralSignature: 'skip',
  });
  const user = await db.user.findUnique({ where: { id: auth.userId } });
  return NextResponse.json({
    token: auth.token,
    authId: auth.authId,
    userId: auth.userId,
    displayName: user?.displayName || null,
    createdAt: user?.createdAt?.toISOString(),
    expiresInDays: 30,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

// GET — return current user (SKIP IP check — just verify token exists)
export async function GET(req: NextRequest) {
  const token = bearerFromHeaders(req.headers);
  if (!token) return NextResponse.json({ authenticated: false });
  // Skip IP + fingerprint verification — just check token exists in DB
  const auth = await verifyToken(token, '0.0.0.0', undefined);
  if (!auth) {
    // Fallback: try without IP restriction
    return NextResponse.json({ authenticated: false });
  }
  const user = await db.user.findUnique({ where: { id: auth.userId } });
  if (!user) return NextResponse.json({ authenticated: false });
  return NextResponse.json({
    userId: user.id,
    authId: user.authId,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
  });
}

// PATCH — logout
export async function PATCH(req: NextRequest) {
  const token = bearerFromHeaders(req.headers);
  if (token) await revokeSession(token);
  return NextResponse.json({ ok: true });
}
