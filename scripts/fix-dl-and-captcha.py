#!/usr/bin/env python3
"""
Fix 1: Add dl.kangwifi.eu.org → aiodl (port 8090) in nginx
Fix 2: Remove captcha/verification from Rara AI
"""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# ═══ Fix 1: Add dl.kangwifi.eu.org → aiodl to nginx config ═════════
print("=== Fix 1: Add dl.kangwifi.eu.org → aiodl ===", flush=True)

# Read current nginx config + add dl.kangwifi.eu.org server block
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cat /etc/nginx/conf.d/rara-nginx.conf'",
    timeout=15
)
current_conf = stdout.read().decode("utf-8", errors="replace")

# Add dl.kangwifi.eu.org server block before the last closing comment
dl_block = """
# dl.kangwifi.eu.org → aiodl (video downloader)
server {
    listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl;
    server_name dl.kangwifi.eu.org;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
"""

new_conf = current_conf + dl_block

# Upload new config
sftp = client.open_sftp()
with sftp.file('/tmp/nginx-with-dl.conf', 'w') as f:
    f.write(new_conf)
sftp.close()

# Apply + reload
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/nginx-with-dl.conf kali:/etc/nginx/conf.d/rara-nginx.conf; "
    "docker exec kali nginx -t 2>&1; "
    "docker exec kali nginx -s reload 2>&1; "
    "sleep 2; "
    "echo; echo '=== test dl.kangwifi.eu.org ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: dl.kangwifi.eu.org' http://127.0.0.1:80/ 2>&1; "
    "echo; echo '=== test rara.ai.id still works ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: rara.ai.id' http://127.0.0.1:80/ 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# ═══ Fix 2: Remove captcha/verification from Rara AI ══════════════
print("\n=== Fix 2: Remove captcha from Rara AI ===", flush=True)

# Edit the auth route to skip ALL checks — just issue token immediately
# Edit LoginScreen to skip fingerprint collection — just POST to /api/auth

# First, backup the original files
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cp /opt/rara-agent/src/app/api/auth/route.ts /opt/rara-agent/src/app/api/auth/route.ts.bak && "
    "cp /opt/rara-agent/src/components/LoginScreen.tsx /opt/rara-agent/src/components/LoginScreen.tsx.bak && "
    "cp /opt/rara-agent/src/app/page.tsx /opt/rara-agent/src/app/page.tsx.bak && "
    "echo backups done"
    "'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Write simplified auth route (no verification — just issue token)
sftp = client.open_sftp()
with sftp.file('/tmp/new-auth-route.ts', 'w') as f:
    f.write("""// POST /api/auth — NO verification, just issue token
// GET /api/auth — return current user
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

  // Skip ALL verification — just login
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

// GET — return current user
export async function GET(req: NextRequest) {
  const token = bearerFromHeaders(req.headers);
  if (!token) return NextResponse.json({ authenticated: false });
  const auth = await verifyToken(token, '0.0.0.0', undefined);
  if (!auth) return NextResponse.json({ authenticated: false });
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
""")

# Write simplified LoginScreen (no fingerprint collection, just POST immediately)
with sftp.file('/tmp/new-login-screen.tsx', 'w') as f:
    f.write(""""use client";

import { useEffect, useState } from "react";
import { login, setToken } from "@/lib/api-client";
import { Rara3D } from "@/components/Rara3D";

type Props = {
  onLoggedIn: () => void;
};

export function LoginScreen({ onLoggedIn }: Props) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Skip ALL fingerprint/captcha — just POST to /api/auth immediately
    login(Date.now())
      .then((r) => {
        setToken(r.token);
        onLoggedIn();
      })
      .catch((e) => {
        setError(e?.message || "Login gagal");
      });
  }, [onLoggedIn]);

  if (error) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0b", color: "#71717a", fontFamily: "monospace" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ margin: "0 auto 16px", width: 56, height: 56 }}><Rara3D mood="shy" size={56} showPlatform={false} /></div>
          <p style={{ fontSize: 14, color: "#f59e0b" }}>{error}</p>
          <button onClick={() => location.reload()} style={{ marginTop: 16, background: "#f59e0b", color: "#0a0a0b", border: 0, borderRadius: 6, padding: "10px 24px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Coba Lagi
          </button>
        </div>
      </div>
    );
  }

  // Loading screen while token is being issued
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0b", color: "#71717a", fontFamily: "monospace" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ margin: "0 auto 16px", width: 56, height: 56 }}><Rara3D mood="happy" size={56} showPlatform={false} /></div>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#FF9CC1", marginBottom: 8 }}>Rara</div>
        <div style={{ fontSize: 12 }}>memuat Rara...</div>
      </div>
    </div>
  );
}
""")

# Also update the login() function in api-client.ts to send minimal body
with sftp.file('/tmp/new-login-fn.txt', 'w') as f:
    f.write("""// Updated login function — minimal body, no fingerprint collection
export async function login(renderTimestamp: number): Promise<LoginResponse> {
  const body = { _ts: renderTimestamp, _fp: 'skip', _bh: 'skip', _hp: '' };
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Login gagal (${res.status})`);
  return j as LoginResponse;
}
""")

sftp.close()
print("  New source files uploaded", flush=True)

# Copy files into container + rebuild Next.js
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/new-auth-route.ts kali:/opt/rara-agent/src/app/api/auth/route.ts && "
    "docker cp /tmp/new-login-screen.tsx kali:/opt/rara-agent/src/components/LoginScreen.tsx && "
    "echo 'files copied' && "
    # Rebuild Next.js
    "echo; echo '=== rebuilding Next.js ==='; "
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -10"
    "'",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart rara-web
print("\n=== Restart rara-web ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== rara.ai.id test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== POST /api/auth (should work without fingerprint) ==='; "
    "curl -s -X POST https://rara.ai.id/api/auth "
    "-H 'Content-Type: application/json' "
    "-H 'User-Agent: Mozilla/5.0 (test)' "
    "-d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' "
    "-w '\\nHTTP %{http_code}\\n' --max-time 10 2>&1 | head -5; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
