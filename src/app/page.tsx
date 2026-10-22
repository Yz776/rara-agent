"use client";

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
