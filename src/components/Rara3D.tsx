"use client";

import { useState, useEffect } from "react";

export type RaraMood = "idle" | "thinking" | "talking" | "happy" | "shy";

interface Rara3DProps {
  mood?: RaraMood;
  size?: number;
  className?: string;
  showPlatform?: boolean;
  autoRotate?: boolean;
}

export function Rara3D({ mood = "idle", size = 240, className, showPlatform = true, autoRotate = false }: Rara3DProps) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Preload image
    const img = new Image();
    img.onload = () => setLoaded(true);
    img.src = "/hiura.png";
  }, []);

  const moodEmoji = {
    idle: "✨",
    thinking: "🤔",
    talking: "💬",
    happy: "😊",
    shy: "😊",
  };

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      {loaded ? (
        <img
          src="/hiura.png"
          alt="Rara — Hiura 3D character"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius: "50%",
            border: "3px solid #FF9CC1",
            boxShadow: "0 0 20px rgba(255, 156, 193, 0.3)",
            animation: autoRotate ? "rara-bounce 2s ease-in-out infinite" : `rara-${mood} 3s ease-in-out infinite`,
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #FF9CC1, #FF4D8C)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: size * 0.3,
            color: "white",
          }}
        >
          {moodEmoji[mood]}
        </div>
      )}
      <style jsx>{`
        @keyframes rara-bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
        @keyframes rara-idle {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-4px) scale(1.02); }
        }
        @keyframes rara-happy {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-6px) rotate(-2deg); }
          75% { transform: translateY(-3px) rotate(2deg); }
        }
        @keyframes rara-thinking {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(3deg); }
        }
        @keyframes rara-talking {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        @keyframes rara-shy {
          0%, 100% { transform: scale(1) rotate(0deg); }
          50% { transform: scale(0.95) rotate(-3deg); }
        }
      `}</style>
    </div>
  );
}

export default Rara3D;
