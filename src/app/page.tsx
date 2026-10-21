"use client";

import { useEffect, useState, useCallback } from "react";
import { ChatApp } from "@/components/ChatApp";
import { LoginScreen } from "@/components/LoginScreen";
import { login, setToken, logout as apiLogout, type AuthMe } from "@/lib/api-client";

export default function Page() {
  const [bootState, setBootState] = useState<"loading" | "authed" | "anonymous">("loading");
  const [me, setMe] = useState<AuthMe | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await login();
        if (cancelled) return;
        setToken(data.token);
        setMe({
          userId: data.userId,
          authId: data.authId,
          displayName: data.displayName || null,
          createdAt: data.createdAt || new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
        setBootState("authed");
      } catch (e: any) {
        if (cancelled) return;
        console.error('Auto-login failed:', e?.message || e);
        // Fall through to LoginScreen which has its own retry logic
        setBootState("anonymous");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onLoggedIn = useCallback(async () => {
    // LoginScreen's onLoggedIn callback — re-fetch user info
    try {
      const data = await login();
      setToken(data.token);
      setMe({
        userId: data.userId,
        authId: data.authId,
        displayName: data.displayName || null,
        createdAt: data.createdAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
      setBootState("authed");
    } catch {
      setBootState("anonymous");
    }
  }, []);

  const onLogout = useCallback(async () => {
    await apiLogout();
    setMe(null);
    setBootState("anonymous");
  }, []);

  if (bootState === "loading") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0b", color: "#71717a", fontFamily: "monospace" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#FF9CC1" }}>Rara</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>memuat Rara…</div>
        </div>
      </div>
    );
  }

  if (bootState === "anonymous" || !me) return <LoginScreen onLoggedIn={onLoggedIn} />;
  return <ChatApp me={me} onLogout={onLogout} />;
}
