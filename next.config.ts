import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  // Three.js / @react-three/fiber should only run client-side. The component
  // file (src/components/Rara3D.tsx) starts with "use client" — that's enough.
  // Security headers — applied to all responses
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Prevent clickjacking
          { key: 'X-Frame-Options', value: 'DENY' },
          // Prevent MIME-type sniffing
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Force HTTPS for 1 year (production only — behind Cloudflare)
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          // Referrer policy — only send origin to same site
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Permissions policy — disable unnecessary browser features
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          // CSP — allow self + inline (needed for Next.js) + data: URIs (for images)
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: https:",
              // connect-src: same-origin + the bundled zrouter on localhost (server-side fetch only,
              // but listed here in case the browser ever needs to reach it during dev)
              "connect-src 'self' http://127.0.0.1:3001 http://localhost:3001",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "base-uri 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  // Three.js ships untranspiled ESM with optional Node-specific modules. Next.js
  // needs to transpile it so the browser bundle works.
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei'],
};

export default nextConfig;
