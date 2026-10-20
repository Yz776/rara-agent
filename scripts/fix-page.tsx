#!/usr/bin/env python3
"""Fix: replace page.tsx entirely — skip LoginScreen, auto-login via direct fetch."""
import paramiko

# The new page.tsx — no LoginScreen, no fingerprint, just auto-login
NEW_PAGE = '''"use client";

import { useEffect, useState, useCallback } from "react";
import { ChatApp } from "@/components/ChatApp";
import { fetchMe, logout as apiLogout, setToken, type AuthMe } from "@/lib/api-client";

export default function Page() {
  const [bootState, setBootState] = useState<"loading" | "authed">("loading");
  const [me, setMe] = useState<AuthMe | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Auto-login: POST to /api/auth directly (NO fingerprint, NO captcha)
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _ts: Date.now(), _fp: 'skip', _bh: 'skip', _hp: '' }),
        });
        const data = await res.json();
        if (data.token) {
          setToken(data.token);
          const user = await fetchMe();
          if (user) {
            setMe(user);
          } else {
            setMe({ userId: data.userId, authId: data.authId, displayName: data.displayName || null, createdAt: data.createdAt || new Date().toISOString(), lastSeenAt: new Date().toISOString() });
          }
          setBootState("authed");
        }
      } catch (e) {
        console.error('Auto-login failed:', e);
      }
    })();
  }, []);

  const onLogout = useCallback(async () => {
    await apiLogout();
    location.reload();
  }, []);

  if (bootState === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0b", color: "#71717a", fontFamily: "monospace" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#FF9CC1" }}>Rara</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>memuat Rara...</div>
        </div>
      </div>
    );
  }

  if (!me) return null;
  return <ChatApp me={me} onLogout={onLogout} />;
}
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Upload new page.tsx via SFTP
print("=== Upload new page.tsx ===", flush=True)
sftp = client.open_sftp()
with sftp.file('/tmp/new-page.tsx', 'w') as f:
    f.write(NEW_PAGE)
sftp.close()
print("  Uploaded", flush=True)

# Copy into container + rebuild + restart
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/new-page.tsx kali:/opt/rara-agent/src/app/page.tsx && "
    "echo 'page.tsx copied' && "
    # Rebuild
    "echo; echo '=== rebuild ==='; "
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -5"
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
    "echo; echo '=== POST /api/auth ==='; "
    "curl -s -X POST http://localhost:3002/api/auth "
    "-H 'Content-Type: application/json' "
    "-d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' "
    "-w '\\nHTTP %{http_code}\\n' --max-time 10 2>&1 | head -3; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
