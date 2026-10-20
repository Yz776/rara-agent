#!/usr/bin/env python3
"""Fix: replace page.tsx + simplify api-client.ts authHeaders/fetchMe to skip fingerprint."""
import paramiko

# New page.tsx — skip fetchMe, use POST response directly
NEW_PAGE = '''"use client";

import { useEffect, useState, useCallback } from "react";
import { ChatApp } from "@/components/ChatApp";
import { logout as apiLogout, setToken, type AuthMe } from "@/lib/api-client";

export default function Page() {
  const [bootState, setBootState] = useState<"loading" | "authed">("loading");
  const [me, setMe] = useState<AuthMe | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _ts: Date.now(), _fp: 'skip', _bh: 'skip', _hp: '' }),
        });
        const data = await res.json();
        if (data.token) {
          setToken(data.token);
          setMe({
            userId: data.userId,
            authId: data.authId,
            displayName: data.displayName || null,
            createdAt: data.createdAt || new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          });
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

# Patch for api-client.ts: replace authHeaders + authHeadersSync + fetchMe to skip fingerprint
# Use sed to replace the functions
PATCH_SCRIPT = r'''import re

with open('src/lib/api-client.ts') as f:
    content = f.read()

# Replace authHeaders — skip collectDeviceFingerprint
old_auth = """export async function authHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = getToken();
  const { hash } = await collectDeviceFingerprint();
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  h['X-KFAI-Device'] = hash;
  return h;
}"""

new_auth = """export async function authHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = getToken();
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}"""

if old_auth in content:
    content = content.replace(old_auth, new_auth)
    print("authHeaders replaced")
else:
    print("authHeaders not found (maybe already replaced)")

# Replace authHeadersSync — skip fingerprint
old_sync = """export function authHeadersSync(extra?: HeadersInit): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (cachedFingerprint) h['X-KFAI-Device'] = cachedFingerprint;
  return h;
}"""

new_sync = """export function authHeadersSync(extra?: HeadersInit): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = { ...(extra as Record<string, string> || {}) };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}"""

if old_sync in content:
    content = content.replace(old_sync, new_sync)
    print("authHeadersSync replaced")
else:
    print("authHeadersSync not found")

# Replace fetchMe — don't call authHeaders (use direct token)
old_fetchme = """export async function fetchMe(): Promise<AuthMe | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch('/api/auth', { headers: await authHeaders() });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}"""

new_fetchme = """export async function fetchMe(): Promise<AuthMe | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch('/api/auth', { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) { return null; }
  return res.json();
}"""

if old_fetchme in content:
    content = content.replace(old_fetchme, new_fetchme)
    print("fetchMe replaced")
else:
    print("fetchMe not found")

with open('src/lib/api-client.ts', 'w') as f:
    f.write(content)
print(f"File size: {len(content)} bytes")
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Upload files via SFTP
sftp = client.open_sftp()
with sftp.file('/tmp/new-page-v2.tsx', 'w') as f:
    f.write(NEW_PAGE)
with sftp.file('/tmp/patch-api-client.py', 'w') as f:
    f.write(PATCH_SCRIPT)
sftp.close()
print("Files uploaded", flush=True)

# Apply changes + rebuild + restart
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/new-page-v2.tsx kali:/opt/rara-agent/src/app/page.tsx && "
    "docker cp /tmp/patch-api-client.py kali:/tmp/patch-api-client.py && "
    "docker exec kali bash -c 'cd /opt/rara-agent && python3 /tmp/patch-api-client.py' && "
    "echo 'files patched' && "
    # Rebuild
    "echo; echo '=== rebuild ==='; "
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -5"
    "' && "
    # Restart
    "echo; echo '=== restart ==='; "
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
