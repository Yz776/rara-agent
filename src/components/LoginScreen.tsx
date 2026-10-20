"use client";

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
