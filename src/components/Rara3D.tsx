"use client";

import { useEffect, useRef, useState, Suspense } from "react";

export type RaraMood = "idle" | "thinking" | "talking" | "happy" | "shy" | "surprised";

interface Rara3DProps {
  mood?: RaraMood;
  size?: number;
  className?: string;
  showPlatform?: boolean;
  autoRotate?: boolean;
}

// Expression images for Hiura VTuber character
// Each mood maps to a specific expression image
const MOOD_IMAGES: Record<RaraMood, string> = {
  idle: "/hiura/idle.png",
  thinking: "/hiura/thinking.png",
  talking: "/hiura/talking.png",
  happy: "/hiura/happy.png",
  shy: "/hiura/shy.png",
  surprised: "/hiura/surprised.png",
};

// Preload all expression images
const imageCache: Record<string, HTMLImageElement> = {};
function preloadImage(src: string): Promise<void> {
  return new Promise((resolve) => {
    if (imageCache[src]) {
      resolve();
      return;
    }
    const img = new Image();
    img.onload = () => {
      imageCache[src] = img;
      resolve();
    };
    img.onerror = () => resolve(); // fail silently
    img.src = src;
  });
}

export function Rara3D({
  mood = "idle",
  size = 240,
  className,
  showPlatform = true,
  autoRotate = false,
}: Rara3DProps) {
  const [loaded, setLoaded] = useState(false);
  const [displayMood, setDisplayMood] = useState<RaraMood>(mood);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevMoodRef = useRef<RaraMood>(mood);

  // Preload all expression images on mount
  useEffect(() => {
    Promise.all(Object.values(MOOD_IMAGES).map(preloadImage)).then(() => {
      setLoaded(true);
    });
  }, []);

  // Smooth mood transitions with a brief "blink" animation
  useEffect(() => {
    if (mood !== prevMoodRef.current) {
      prevMoodRef.current = mood;
      const timer = setTimeout(() => setDisplayMood(mood), 150);
      return () => clearTimeout(timer);
    }
  }, [mood]);

  const imgSrc = MOOD_IMAGES[displayMood] || MOOD_IMAGES.idle;

  // Animation classes based on mood
  const animationClass = (() => {
    switch (displayMood) {
      case "happy":
        return "hiura-bounce";
      case "thinking":
        return "hiura-tilt";
      case "talking":
        return "hiura-talk";
      case "shy":
        return "hiura-shrink";
      case "surprised":
        return "hiura-pop";
      default:
        return "hiura-breathe";
    }
  })();

  return (
    <div
      ref={containerRef}
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
        <div
          key={displayMood}
          className={`hiura-container ${animationClass}`}
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Circular frame with glow */}
          <div
            style={{
              width: "90%",
              height: "90%",
              borderRadius: "50%",
              overflow: "hidden",
              border: "3px solid #FF9CC1",
              boxShadow: "0 0 20px rgba(255, 156, 193, 0.4), inset 0 0 10px rgba(255, 156, 193, 0.2)",
              position: "relative",
              background: "#1a1a22",
            }}
          >
            <img
              src={imgSrc}
              alt={`Hiura — ${displayMood}`}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center top",
                transition: "opacity 0.15s ease-in-out",
                animation: displayMood === "talking" ? "hiura-lipsync 0.15s ease-in-out infinite" : "none",
              }}
            />
            {/* Subtle gradient overlay for depth */}
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: "30%",
                background: "linear-gradient(to top, rgba(255, 156, 193, 0.15), transparent)",
                pointerEvents: "none",
              }}
            />
          </div>

          {/* Mood indicator sparkle */}
          <div
            style={{
              position: "absolute",
              top: "5%",
              right: "10%",
              fontSize: size * 0.08,
              opacity: 0.8,
              animation: "hiura-sparkle 2s ease-in-out infinite",
              filter: "drop-shadow(0 0 4px rgba(255, 156, 193, 0.6))",
            }}
          >
            {displayMood === "happy" ? "✨" : displayMood === "thinking" ? "💭" : displayMood === "talking" ? "💬" : displayMood === "shy" ? "🌸" : displayMood === "surprised" ? "❗" : "⭐"}
          </div>
        </div>
      ) : (
        <div
          style={{
            width: "90%",
            height: "90%",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #FF9CC1, #FF4D8C)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: size * 0.25,
            color: "white",
            animation: "hiura-pulse 1.5s ease-in-out infinite",
          }}
        >
          ✨
        </div>
      )}

      {showPlatform && (
        <div
          style={{
            position: "absolute",
            bottom: -size * 0.05,
            left: "50%",
            transform: "translateX(-50%)",
            width: "70%",
            height: size * 0.04,
            background: "radial-gradient(ellipse, rgba(255, 156, 193, 0.3), transparent 70%)",
            borderRadius: "50%",
            filter: "blur(4px)",
          }}
        />
      )}

      <style jsx>{`
        @keyframes hiura-breathe {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-3px) scale(1.01); }
        }
        @keyframes hiura-bounce {
          0%, 100% { transform: translateY(0); }
          25% { transform: translateY(-8px); }
          50% { transform: translateY(0); }
          75% { transform: translateY(-4px); }
        }
        @keyframes hiura-tilt {
          0%, 100% { transform: rotate(0deg); }
          30% { transform: rotate(4deg) translateY(-2px); }
          70% { transform: rotate(-2deg) translateY(-1px); }
        }
        @keyframes hiura-talk {
          0%, 100% { transform: scale(1) translateY(0); }
          50% { transform: scale(1.03) translateY(-2px); }
        }
        @keyframes hiura-lipsync {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(1px) scaleY(0.98); }
        }
        @keyframes hiura-shrink {
          0%, 100% { transform: scale(1) rotate(0deg); }
          50% { transform: scale(0.95) rotate(-3deg) translateY(2px); }
        }
        @keyframes hiura-pop {
          0% { transform: scale(0.9); }
          50% { transform: scale(1.05); }
          100% { transform: scale(1); }
        }
        @keyframes hiura-sparkle {
          0%, 100% { opacity: 0.5; transform: scale(1) rotate(0deg); }
          50% { opacity: 1; transform: scale(1.2) rotate(15deg); }
        }
        @keyframes hiura-pulse {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.05); opacity: 1; }
        }
        .hiura-container {
          animation-duration: 3s;
          animation-iteration-count: infinite;
          animation-timing-function: ease-in-out;
        }
      `}</style>
    </div>
  );
}

export default Rara3D;
