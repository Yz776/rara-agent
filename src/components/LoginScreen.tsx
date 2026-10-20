"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { login, setToken } from "@/lib/api-client";
import { Rara3D } from "@/components/Rara3D";

type Props = {
  onLoggedIn: () => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// LoginScreen — simplified (no device verification, no captcha, no time-trap).
// Auto-calls /api/auth on mount, gets a token back, hands off to ChatApp.
// ─────────────────────────────────────────────────────────────────────────────
export function LoginScreen({ onLoggedIn }: Props) {
  const [stage, setStage] = useState("Memulai session...");
  const [error, setError] = useState<string | null>(null);
  const loginAttemptedRef = useRef(false);
  const retryCountRef = useRef(0);
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;

  // ── Auto-login on mount (and on manual retry) ─────────────────────────────
  const runAutoLogin = useCallback(async () => {
    setError(null);
    retryCountRef.current++;

    setStage("Menghubungi server...");
    if (loginAttemptedRef.current) return;
    loginAttemptedRef.current = true;

    try {
      const r = await login();
      setToken(r.token);
      setStage("Berhasil!");
      onLoggedInRef.current();
    } catch (e: any) {
      const msg = e?.message || "Gagal masuk";
      setError(msg);

      // Cloudflare edge blocks don't improve with retries — surface actionable guidance.
      if (e?.isCloudflare) {
        setStage("Diblokir Cloudflare");
        return;
      }

      // Other errors (502 bot-block, 429 rate-limit, transient network) →
      // retry up to 3 times with 2s backoff, then show manual retry button.
      if (retryCountRef.current < 3) {
        setStage("Mencoba lagi...");
        loginAttemptedRef.current = false;
        setTimeout(() => runAutoLogin(), 2000);
      } else {
        setStage("Gagal — klik untuk coba lagi");
      }
    }
  }, []);

  useEffect(() => {
    runAutoLogin();
  }, [runAutoLogin]);

  const manualRetry = () => {
    retryCountRef.current = 0;
    loginAttemptedRef.current = false;
    runAutoLogin();
  };

  return (
    <div className="kfai-login">
      <div className="kfai-login-card" style={{ textAlign: "center" }}>
        <div className="kfai-login-brand" style={{ justifyContent: "center", marginBottom: 28 }}>
          <div className="rara-mark-3d" aria-hidden style={{ width: 56, height: 56 }}>
            <Rara3D mood="happy" size={56} showPlatform={false} />
          </div>
          <div>
            <div className="kfai-login-title">Rara</div>
            <div className="kfai-login-sub">{"// asisten AI ceria & manis"}</div>
          </div>
        </div>

        {/* Stage indicator */}
        <div className="kfai-fp-stage" style={{ justifyContent: "center" }}>
          {!error && <span className="kfai-fp-spinner" />}
          {error && retryCountRef.current >= 3 && <span style={{ color: "#f59e0b" }}>⚠</span>}
          <span>{stage}</span>
        </div>

        {/* Manual retry button — appears after 3 failed attempts OR on Cloudflare block */}
        {error && (retryCountRef.current >= 3 || stage === "Diblokir Cloudflare") && (
          <button
            onClick={manualRetry}
            style={{
              marginTop: 16,
              background: "#f59e0b",
              color: "#0a0a0b",
              border: "none",
              borderRadius: 6,
              padding: "10px 24px",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "monospace",
              textTransform: "uppercase",
            }}
          >
            Coba Lagi
          </button>
        )}

        {error && retryCountRef.current < 3 && stage !== "Diblokir Cloudflare" && (
          <div className="kfai-login-error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {error && stage === "Diblokir Cloudflare" && (
          <div className="kfai-login-error" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <div className="kfai-login-hint" style={{ marginTop: 20 }}>
          <b>Login otomatis · 1 IP = 1 session</b>
          <br />
          Tidak perlu verifikasi perangkat — masuk langsung berbasis IP.
        </div>
      </div>
    </div>
  );
}
