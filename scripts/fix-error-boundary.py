#!/usr/bin/env python3
"""
Fix conversation switching crash + provide admin keys.
1. Add React Error Boundary around ChatApp in page.tsx
2. Rebuild + restart
3. Show admin keys
"""
import paramiko

# New page.tsx with Error Boundary
NEW_PAGE = '''"use client";

import { useEffect, useState, useCallback, Component, ReactNode } from "react";
import { ChatApp } from "@/components/ChatApp";
import { logout as apiLogout, setToken, type AuthMe } from "@/lib/api-client";

// Error Boundary — catches client-side errors and shows friendly message
class ErrorBoundary extends Component<{children: ReactNode}, {hasError: boolean; error: string}> {
  constructor(props: {children: ReactNode}) {
    super(props);
    this.state = { hasError: false, error: "" };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message || "Unknown error" };
  }
  componentDidCatch(error: Error) {
    console.error("ChatApp error:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0b", color: "#71717a", fontFamily: "monospace", padding: 20 }}>
          <div style={{ textAlign: "center", maxWidth: 400 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🌸</div>
            <h2 style={{ color: "#FF9CC1", fontSize: 18, marginBottom: 8 }}>Rara istirahat sebentar</h2>
            <p style={{ fontSize: 12, color: "#71717a", marginBottom: 16 }}>{this.state.error.substring(0, 200)}</p>
            <button
              onClick={() => { this.setState({ hasError: false, error: "" }); location.reload(); }}
              style={{ background: "#FF9CC1", color: "#0a0a0b", border: 0, borderRadius: 6, padding: "10px 24px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
            >
              Coba Lagi
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  return (
    <ErrorBoundary>
      <ChatApp me={me} onLogout={onLogout} />
    </ErrorBoundary>
  );
}
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Upload new page.tsx
print("=== Upload page.tsx with Error Boundary ===", flush=True)
sftp = client.open_sftp()
with sftp.file('/tmp/page-error-boundary.tsx', 'w') as f:
    f.write(NEW_PAGE)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/page-error-boundary.tsx kali:/opt/rara-agent/src/app/page.tsx && "
    "echo 'page.tsx updated with Error Boundary'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Rebuild
print("\n=== Rebuild Next.js ===", flush=True)
stdin, stdout, stderr = client.exec_command(
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

# Restart
print("\n=== Restart + test ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
