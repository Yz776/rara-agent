// Static favicon — rendered as an SVG via Next.js's icon route convention.
// Using a React component instead of a static .svg file because Next.js 16
// has a bug: "Failed to collect page data for /icon.svg" → TypeError:
// fnOrEmpty is not a function. The .tsx variant is treated as a route
// handler, which doesn't trigger the broken static-asset collection.
import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/svg+xml";

// Render a simple SVG with the "K" letter on an amber background — same
// visual as the old static icon.svg.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f59e0b",
          color: "#0a0a0b",
          fontSize: 22,
          fontWeight: 700,
          fontFamily: "monospace",
          borderRadius: 6,
        }}
      >
        R
      </div>
    ),
    size
  );
}
