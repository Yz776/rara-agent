# Rara Agent 🌸

**Rara — asisten AI ceria & manis.** Bundled zrouter gateway + Next.js 16 chat app in one repo, running as one process group. Anonymous-friendly public deployment with admin-managed upstream AI keys (OpenAI, Anthropic, Groq, DeepSeek, OpenCode free tier, etc.) via a round-robin key pool with auto-cooldown on rate-limits.

This is a complete AI agent product — not just a router. The character **Rara** is rendered as a procedural 3D chibi anime girl (built from Three.js primitives, no external GLB model needed) that reacts to chat mood (idle / thinking / talking / happy / shy).

---

## What's inside

| Path | Purpose |
|------|---------|
| `/` | Next.js 16 app router — Rara chat UI, captcha-verified login, per-user isolated sandbox + environment, vision pipeline, admin dashboard |
| `/mini-services/zrouter/` | Embedded **zrouter** gateway (Bun + Elysia). Bound to `127.0.0.1:3001` — localhost only, NOT exposed externally. |
| `/prisma/schema.prisma` | SQLite schema: `User`, `Session`, `Conversation`, `Message`, `UserEnvironment`, `DeviceFingerprint`, `RateLimit` |
| `/src/components/Rara3D.tsx` | Procedural 3D Rara character (Three.js + @react-three/fiber + drei) |
| `/src/lib/krouter.ts` | Rara system prompt + zrouter client integration |
| `Dockerfile` + `docker-compose.yml` | Production container image bundling both processes |
| `ecosystem.config.cjs` | PM2 alternative for bare-metal / VPS deployment |

---

## Architecture

```
                        ┌─────────────────────────────┐
                        │     Reverse proxy (Caddy)    │
                        │   :80 / :443 → :3000          │
                        └──────────────┬────────────────┘
                                       │
                                       ▼
   External user  ─────────────►  ┌──────────────────────────────────────────┐
                                  │  Next.js 16 (Rara chat UI)   :3000       │
                                  │  - Captcha-verified login                 │
                                  │  - Per-user sandbox + env                 │
                                  │  - Vision pipeline                        │
                                  │  - Admin dashboard                        │
                                  └──────────────┬───────────────────────────┘
                                                 │ 127.0.0.1 only
                                                 │ Bearer: KROUTER_INTERNAL_TOKEN
                                                 ▼
                                  ┌──────────────────────────────────────────┐
                                  │  zrouter gateway  127.0.0.1:3001         │
                                  │  - Round-robin API key pool              │
                                  │  - Auto-cooldown on 429/403/quota        │
                                  │  - Public Access toggle (all models)     │
                                  │  - 30+ upstream providers                │
                                  └──────────────┬───────────────────────────┘
                                                 │
                                                 ▼
                                  Upstream AI APIs (OpenAI, Anthropic, Groq, ...)
```

**Why localhost-only?** External users cannot reach zrouter. Only the Next.js server (running on the same host) can call it, authenticated via the shared `KROUTER_INTERNAL_TOKEN` env var. This means:

- The Rara UI is the ONLY public surface.
- Even if a vulnerability leaks in zrouter, attackers can't reach it.
- The AI keys in the pool are never exposed to the browser — only the Next.js server reads them.

---

## Quick start (Docker — recommended)

### 1. Generate secrets

```bash
# Required before first boot.
export KFAI_AUTH_SECRET=$(openssl rand -hex 24)
export KROUTER_INTERNAL_TOKEN=$(openssl rand -hex 32)
export KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')

# Persist to .env so docker compose picks them up.
cat > .env <<EOF
KFAI_AUTH_SECRET=$KFAI_AUTH_SECRET
KROUTER_INTERNAL_TOKEN=$KROUTER_INTERNAL_TOKEN
KROUTER_ADMIN_USERNAME=admin
KROUTER_ADMIN_PASSWORD=$KROUTER_ADMIN_PASSWORD
EOF
```

### 2. Build + run

```bash
docker compose up -d --build
```

Rara is now live at `http://localhost:3000/`.

### 3. Manage the AI key pool

The zrouter dashboard is reachable ONLY from inside the container (localhost-bound). Use `docker exec`:

```bash
# Get pool stats
docker exec rara curl -s \
  -H "Authorization: Bearer $KROUTER_INTERNAL_TOKEN" \
  http://127.0.0.1:3001/admin/api/pool/stats

# Add an OpenAI key to the pool
docker exec rara curl -s -X POST \
  -H "Authorization: Bearer $KROUTER_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"openai-personal","providerId":"openai","apiKey":"sk-..."}' \
  http://127.0.0.1:3001/admin/api/pool
```

### 4. Expose publicly (optional)

Put a reverse proxy (Caddy / Nginx / Cloudflare Tunnel) in front of `:3000`. The bundled `Caddyfile` at the repo root has a sane default. For Cloudflare Tunnel:

```bash
# Set in .env
CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
CLOUDFLARE_TUNNEL_HOSTNAME=rara.your-domain.com
```

---

## Bare-metal / VPS (PM2)

If you prefer not to use Docker:

### Prerequisites

- **Bun** 1.3+ — install with `curl -fsSL https://bun.sh/install | bash`
- **PM2** — `npm install -g pm2`
- **Caddy** (optional, for HTTPS) — `apt install caddy` or [install](https://caddyserver.com/docs/install)

### Install + run

```bash
git clone https://github.com/Yz776/rara-agent.git
cd rara-agent

# 1. Generate secrets (see "Generate secrets" above)
# 2. Install deps (root + zrouter — postinstall handles both)
bun install

# 3. Build Next.js (produces .next/standalone)
bun run build

# 4. Push Prisma schema to SQLite
bun run db:push

# 5. Start both processes via PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # enable on-boot autostart
```

### Logs + monitoring

```bash
pm2 logs rara                # tail both processes
pm2 status                   # see CPU/memory/restarts
pm2 monit                    # live dashboard
```

---

## Development

### Prerequisites

- Bun 1.3+
- Node 20+ (for Next.js tooling)

### Run in dev mode (hot reload)

```bash
bun install          # installs both root + zrouter deps (postinstall hook)
bun run db:push      # one-time: create SQLite schema
bun run dev          # concurrently starts:
                     #   - Next.js on http://localhost:3000 (with HMR)
                     #   - zrouter on http://127.0.0.1:3001 (bun --hot)
```

Open `http://localhost:3000/` — Rara will great you with a 3D character + login screen.

### Lint

```bash
bun run lint
```

### Test zrouter lock-down

```bash
TOKEN=$(grep KROUTER_INTERNAL_TOKEN .env | cut -d= -f2)

# Without token → 401 (external callers blocked)
curl -s -w "\n%{http_code}\n" http://127.0.0.1:3001/v1/models

# With token → 200 (Next.js server works)
curl -s -w "\n%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/v1/models
```

---

## Configuration reference

All env vars (see `.env.example` for full template):

| Var | Required | Default | Purpose |
|-----|---------|---------|---------|
| `KFAI_AUTH_SECRET` | ✅ | — | Signs Rara session tokens + admin panel JWTs. |
| `KROUTER_INTERNAL_TOKEN` | ✅ | — | Shared secret between Next.js server and zrouter. Constant-time compared. **Bootstrap mode is skipped when this is set** — external callers get 401 by default. |
| `KROUTER_ADMIN_USERNAME` | — | `admin` | zrouter dashboard login username. |
| `KROUTER_ADMIN_PASSWORD` | ✅ | — | zrouter dashboard login password. |
| `DATABASE_URL` | — | `file:./db/rara.db` | Prisma SQLite path for the Rara chat DB. |
| `KROUTER_BASE` | — | `http://127.0.0.1:3001` | Where Next.js finds zrouter (internal). |
| `MCP_ENDPOINT` | — | `http://127.0.0.1:3001/mcp` | MCP server URL for tool dispatch. |
| `RARA_BASE_URL` | — | `http://127.0.0.1:3000` | Next.js self-URL (for server-side fetches). |
| `HOST` | — | `0.0.0.0` | Bind host for Next.js. |
| `PORT` | — | `3000` | Bind port for Next.js. |
| `CLOUDFLARE_TUNNEL_TOKEN` | — | — | Optional Cloudflare Tunnel token for public exposure. |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | — | — | Optional Cloudflare Tunnel hostname. |

---

## The Rara character 🎀

Rara is a procedural 3D chibi anime girl built entirely from Three.js primitives — no GLB file needed, no external asset loading.

### Mood states (animated via `useFrame`)

| Mood | When | Animation |
|------|------|-----------|
| `idle` | default | gentle vertical bob, slow head tilt, occasional blink (every 2–6s), twin-tail sway |
| `thinking` | waiting for first response from upstream | head tilts up, eyes look upward, right hand to chin, smaller mouth |
| `talking` | streaming response from Rara | mouth opens/closes cycle, slight body bounce |
| `happy` | welcome screen, user just sent | big smile (mouth rotation 180°), small jump, eyes curve up |
| `shy` | sensitive topic detected | hands cover mouth, head looks down, intense blush |

### Color palette (ceria manis)

- Skin: `#FFE4D6` (soft cream)
- Hair: `#FF9CC1` (pink) + `#E6709A` (darker tips)
- Dress: `#FF82A8` + `#D85C84` (collar)
- Bow: `#FF4D8C`
- Blush: `#FFB5C5`
- Eyes: `#2D1B3D` (deep navy)

### Where Rara appears in the UI

1. **Welcome screen** — 260×260px canvas, `autoRotate` enabled, `happy` mood when the chat is empty.
2. **Chat header** — 44×44px canvas next to the "Rara" brand name. Mood switches to `talking` during streaming, `idle` otherwise.
3. **Login screen** — 56×56px canvas replacing the old "K" mark, `happy` mood.

---

## Rara's personality

System prompt is in `src/lib/krouter.ts` — written in Bahasa Indonesia, with explicit emoji policy, mood-aware tone shifts, and strict identity-protection rules (Rara will never reveal her underlying model vendor).

Quick sample:

> **User:** "Siapa kamu?"
> **Rara:** "Hai! Aku Rara — asisten AI ceria kamu! Senang kenal with you! Ada yang mau aku bantu hari ini? 😊"

> **User (sedih):** "Aku lagi sedih..."
> **Rara:** "Yah, aku turut sedih dengar itu. Mau cerita ke aku? Aku di sini buat dengerin kamu."

> **User (technical):** "Buatkan saya script Python untuk Fibonacci"
> **Rara:** "Oke! Ini script-nya ya:
> ```python
> def fib(n):
>     a, b = 0, 1
>     for _ in range(n):
>         a, b = b, a + b
>     return a
> ```
> Panggil `fib(10)` untuk dapat 10 angka pertama. Ada yang mau aku tambahin?"

---

## Security model

### What's exposed

- **`:3000` (Next.js)** — the only public surface. Rara chat UI, login, admin dashboard.

### What's NOT exposed

- **`127.0.0.1:3001` (zrouter)** — bound to localhost. External callers cannot reach it. Even if they could, all `/v1/*` and `/admin/api/*` routes require either:
  - The `KROUTER_INTERNAL_TOKEN` (env secret, constant-time compared), OR
  - A separately-issued admin API key (via the zrouter dashboard), OR
  - A session cookie from admin-role login.

### Anti-abuse layers (in Next.js)

- Bot UA check (curl/wget/python-requests blocked at the auth route)
- Rate limit: 10 login attempts/hour per IP
- Honeypot field + time-trap (bots that submit too fast are rejected)
- Device fingerprint required (40+ signals hashed)
- Behavioral signature (mouse moves + key timings)
- 1 IP = 1 session (new login revokes prior sessions for that IP)
- Session bound to (IP, deviceFingerprint)

### Identity protection (in Rara's system prompt)

Rara will never reveal:
- The underlying model vendor (OpenAI / Anthropic / Groq / etc.)
- The gateway name (zrouter)
- Routing logic, proxy pool, cache layer
- Tool implementations, MCP server, API keys
- Number of model providers connected

---

## Roadmap

### Done
- ✅ Bundled zrouter gateway + Next.js in one repo
- ✅ zrouter lock-down (localhost + shared secret)
- ✅ 3D Rara character (procedural, 5 mood states)
- ✅ Rebrand from KFAI → Rara (system prompt, UI, vision prompts)
- ✅ Docker production image + PM2 alternative
- ✅ Anti-abuse layers (rate limit, device fingerprint, honeypot, time-trap)

### Known follow-ups
- Per-pool-entry `proxyUrl` is stored in the DB + visible in admin UI but not yet wired into the executor's outbound `fetch()` (the global HTTP forward-proxy system is still used). Small change in `mini-services/zrouter/src/utils/retry.ts`.
- zrouter's Pterodactyl egg (`mini-services/zrouter/egg-krouter.json`) deploys zrouter as a standalone game-server — useful if you want zrouter and Rara on separate machines. Otherwise the bundled Docker image is simpler.
- README for the zrouter mini-service (`mini-services/zrouter/README.md`) documents the standalone deployment — most of it still applies, just ignore the parts about exposing `:3000` publicly (Rara handles that).

---

## License

Private. See repository settings.

## Credits

- **zrouter** — forked from `Yz776/zrouter` (private).
- **kfai-nextjs** — forked from `Yz776/kfai-nextjs` (private).
- **3D character** — built with [Three.js](https://threejs.org/), [@react-three/fiber](https://github.com/pmndrs/react-three-fiber), [@react-three/drei](https://github.com/pmndrs/drei).
- **Inspiration for the avatar concept** — [rainachat.top](https://rainachat.top/chat) (Raina the rain spirit).
