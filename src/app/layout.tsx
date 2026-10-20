import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});
const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rara — Ceria Manis AI Assistant",
  description: "Rara — asisten AI ceria dan manis. Login terverifikasi captcha, environment per-user terisolasi.",
  keywords: ["Rara","ceria","manis","AI assistant","krouter","tool calling","captcha auth"],
  authors: [{ name: "Rara Agent" }],
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id" suppressHydrationWarning>
      {/* suppressHydrationWarning on body: Cloudflare Rocket Loader + Challenge
          Platform inject <script> nodes into <head> AFTER React hydrates.
          This causes DOM mismatch and "removeChild" errors. suppressHydrationWarning
          tells React to ignore those injected nodes. */}
      <body
        className={`${inter.variable} ${mono.variable} antialiased`}
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
