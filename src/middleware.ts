import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Host whitelist — protects rara.ai.id content from being served on
 * accidental Cloudflare DNS aliases (e.g. dl.kangwifi.eu.org pointing
 * to the same origin as rara.ai.id).
 *
 * Before this middleware existed, any domain proxied to the same origin
 * served the full Rara Next.js app — including login, chat, admin panel.
 * Now any non-whitelisted Host gets a clean 404 with a link to the
 * canonical domain.
 *
 * Allowed hosts:
 *   - rara.ai.id            production
 *   - www.rara.ai.id        www alias
 *   - localhost / 127.0.0.1 / 0.0.0.0  local dev
 *   - preview-*.space-z.ai  sandbox preview environment
 *   - bare IP of the server (in case of direct IP access)
 */
const ALLOWED_HOSTS = new Set<string>([
  'rara.ai.id',
  'www.rara.ai.id',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '209.50.50.121', // direct IP access still works
]);

const PREVIEW_HOST_PATTERN = /^preview-[a-z0-9-]+\.space-z\.ai$/i;

export function middleware(req: NextRequest) {
  const rawHost = req.headers.get('host') || '';
  // Strip port if present (e.g. "localhost:3000" -> "localhost")
  const hostname = rawHost.split(':')[0].toLowerCase();

  // Allow whitelisted hosts + preview pattern.
  if (ALLOWED_HOSTS.has(hostname) || PREVIEW_HOST_PATTERN.test(hostname)) {
    return NextResponse.next();
  }

  // For any other Host (dl.kangwifi.eu.org, random subdomains, etc.),
  // refuse to serve Rara content. Return a clean 404 that explains the
  // situation and points to the canonical domain.
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — Host tidak dikenal</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#222;padding:2rem;max-width:560px;margin:8vh auto;text-align:center;line-height:1.5}
  h1{font-size:1.5rem;margin:0 0 1rem;color:#c0392b}
  code{background:#eee;padding:.15rem .35rem;border-radius:4px;font-size:.95em}
  a{color:#2563eb}
  .hint{margin-top:2rem;font-size:.85rem;color:#666}
</style>
</head>
<body>
<h1>404 — Host tidak dikenal</h1>
<p>Domain <code>${escapeHtml(hostname)}</code> tidak terdaftar untuk melayani aplikasi Rara.</p>
<p>Silakan kunjungi <a href="https://rara.ai.id">https://rara.ai.id</a>.</p>
<p class="hint">Jangan di-proxy ke origin ini — setiap Host di luar whitelist rara.ai.id otomatis ditolak.</p>
</body>
</html>`;

  return new NextResponse(html, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      // Help search engines not index this stub
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Run on everything EXCEPT static asset chunks (those can pass through;
// they're just bundle files, no Host-sensitive content).
// Excluded: _next/static/*, _next/image/*, favicon.ico.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
