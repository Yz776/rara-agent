# Rara Agent

**Rara — asisten AI ceria & manis.** Self-contained Next.js 16 chat app with a **bundled opencode.ai free-tier AI gateway**. No external services, no zrouter, no proxy pool — the Next.js process itself calls `https://opencode.ai/zen/v1/chat/completions` with `Authorization: Bearer public` and wraps each request in the captured OpenCode persona (system prompt + tool set) so the free-tier gate accepts it.

Anonymous-friendly public deployment: any visitor gets a per-IP isolated session, no signup, no API key. Set `OPENCODE_API_KEY` to upgrade from free-tier to a real opencode.ai account.

## What's inside

| Path | What |
| --- | --- |
| `/src/app/` | Next.js 16 app router (pages, API routes for chat, auth, conversations, files, admin, vision). |
| `/src/components/Rara3D.tsx` | VTuber-style 3D character (6 mood expressions: idle / thinking / talking / happy / shy / surprised). |
| `/src/components/ChatApp.tsx` | Main chat UI. Imperative DOM for the stream + React-managed welcome overlay (split to avoid the React `removeChild` crash). |
| `/src/lib/krouter.ts` | Rara's personality, tool list, and `callKrouterStream()` — wraps `src/lib/opencode/client.ts`. |
| `/src/lib/opencode/client.ts` | **Bundled AI gateway.** Direct streaming client for opencode.ai. Persona-wraps every free-tier request. |
| `/src/lib/opencode/persona.ts` | Persona system prompt + tool set, plus argument-translation helpers. |
| `/src/lib/opencode/persona.json` | Captured real-client system + tool set (verbatim, 32 KB). Required for free-tier 200s. |
| `/src/lib/opencode/stream.ts` | SSE line iterator + `data:` parser. |
| `/src/lib/mcp.ts` | Stub. The `krouter_*` admin tools are kept in the system prompt for backward-compat but return a graceful "not available" message. |
| `/prisma/schema.prisma` | SQLite schema (User, Conversation, Message, Session, File, AuditLog, etc.). |
| `/Dockerfile` | Multi-stage build: `node:22-alpine` builder → `node:22-alpine` runtime. Single Next.js process, exposes `:3000`. |
| `/docker-compose.yml` | Pulls `ghcr.io/yz776/rara-agent:latest`. Volumes for db + sandbox. |
| `/ecosystem.config.cjs` | PM2 config for bare-metal VPS deploy. |

## Architecture

```
                              Internet
                                 │
                                 ▼
                     Cloudflare (proxy, SSL Full)
                                 │
                                 ▼
                          Nginx reverse proxy
                       (listens :80 + :443)
                                 │
                                 ▼
                         Next.js standalone
                        (node server.js :3000)
                                 │
                                 ▼
                  src/lib/opencode/client.ts
            (Authorization: Bearer public, persona-wrapped)
                                 │
                                 ▼
                       https://opencode.ai
                       /zen/v1/chat/completions
                      (OpenAI-compatible, free)
```

The browser never talks to opencode.ai directly — every AI call goes through Rara's `/api/chat` route, which streams reasoning + content + tool-call deltas back as Server-Sent Events.

## Why no external gateway?

Before v2, Rara bundled `zrouter` as a sidecar service on `127.0.0.1:3001`. That worked, but it added:
- An extra process to start, monitor, and restart (`concurrently` + PM2 dual-app).
- An extra Docker layer + Bun install for the zrouter source.
- A shared-secret (`KROUTER_INTERNAL_TOKEN`) between Next.js and zrouter.
- A second SQLite DB for the key pool.

In practice the only provider Rara actually used was `opencode/big-pickle` (free tier). All the pool / virtual-key / proxy machinery was dead weight. v2 inlines the 3 files that matter — `opencode-persona.json`, `opencode-persona.ts`, `stream.ts` — and drops everything else. The result is a single-process Next.js app that calls opencode.ai directly, with the same persona-wrapping that made free-tier work before.

## Quick start (Docker)

```bash
# 1. Generate secrets
export KFAI_AUTH_SECRET=$(openssl rand -hex 24)
export KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18)

# 2. Pull + run
docker compose up -d

# 3. Tail logs
docker compose logs -f rara
```

Visit `http://localhost:8080` — the welcome screen loads, you can chat immediately (no signup), the Rara character renders with 6 mood expressions.

## Bare-metal (PM2)

```bash
# 1. Install Node 22 + npm
# 2. Install deps
npm install

# 3. Build
npm run build

# 4. Generate secrets (write to .env)
cat > .env <<EOF
KFAI_AUTH_SECRET=$(openssl rand -hex 24)
KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18)
KROUTER_ADMIN_USERNAME=admin
DATABASE_URL=file:./db/rara.db
EOF

# 5. Push DB schema
npx prisma db push --accept-data-loss

# 6. Start
pm2 start ecosystem.config.cjs
pm2 logs rara-web
```

## Admin panel

Visit `/admin` — login with `KROUTER_ADMIN_USERNAME` (default `admin`) + `KROUTER_ADMIN_PASSWORD`. Shows user list, conversation history, audit log, rate-limit stats. The `krouter_*` MCP admin tools that used to live in zrouter are no longer available — manage upstream keys via opencode.ai's dashboard instead.

## Environment variables

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KFAI_AUTH_SECRET` | ✅ | — | Random hex string used to sign user JWTs. |
| `KROUTER_ADMIN_PASSWORD` | ✅ | — | Admin panel login password. |
| `KROUTER_ADMIN_USERNAME` | — | `admin` | Admin panel login username. |
| `DATABASE_URL` | — | `file:./db/rara.db` | Prisma SQLite URL. |
| `OPENCODE_API_KEY` | — | `""` (= free-tier `Bearer public`) | Optional real opencode.ai account Bearer for higher rate limits. |
| `RARA_BASE_URL` | — | `http://127.0.0.1:3000` | Self URL (used for vision tool download links). |
| `RATE_LIMIT_LOGIN_PER_HOUR` | — | `30` | Per-IP login attempts. |
| `RATE_LIMIT_CHAT_PER_HOUR` | — | `120` | Per-IP chat messages. |
| `RATE_LIMIT_ADMIN_PER_HOUR` | — | `300` | Per-IP admin API calls. |

Legacy env vars (`KROUTER_BASE`, `KROUTER_INTERNAL_TOKEN`, `MCP_ENDPOINT`, `KROUTER_DATA_DIR`) are kept as no-ops in the config files so existing `.env` files don't crash startup. They are not used to reach any external service.

## The 3D character

Rara is a Hiura-style VTuber character with 6 mood expressions, each a separate PNG in `public/hiura/`:
- `hiura-idle.png` — gentle breathing animation, slow blink
- `hiura-thinking.png` — appears when the model emits `<think>` reasoning
- `hiura-talking.png` — mouth animation, used while streaming content
- `hiura-happy.png` — appears on task_complete / positive sentiment
- `hiura-shy.png` — appears on user sadness / emotional intensity
- `hiura-surprised.png` — appears on unexpected user input / questions

Mood transitions are pure CSS (cross-fade + slight bounce), no Three.js needed — the previous procedural Three.js character was replaced because the WebGL context was colliding with the imperative DOM in the chat thread and triggering `removeChild` errors.

## React DOM fix

The original `ChatApp.tsx` mixed React-managed children (welcome screen, loading screen) with imperative DOM manipulation (`threadRef.appendChild(...)`, `threadRef.innerHTML = ""`) in the SAME container. When React tried to reconcile its managed children, the DOM was already gone → `Failed to execute 'removeChild' on 'Node'`.

Fix: the chat thread is now two siblings inside `.kfai-thread`:
- `<div ref={threadRef} />` — imperative-only. React never adds children here.
- `{welcome}` / `{loading}` — React-managed, conditional.

So React's reconciliation never touches DOM the imperative code manages, and the imperative code's `replaceChildren()` never wipes React-managed children.

## Security model

- **Anonymous access**: any visitor gets a per-IP session. No signup, no API key. Each IP is rate-limited independently.
- **Per-user isolation**: every user (anonymous or admin) gets their own SQLite row + sandbox directory. Files saved by user A are invisible to user B.
- **Server-side AI calls**: the browser never sees the opencode.ai Bearer or the persona JSON. All AI calls go through Rara's `/api/chat` route.
- **CSP**: `default-src 'self'`, `connect-src 'self' https://opencode.ai`, `frame-ancestors 'none'`.
- **Identity protection**: Rara's system prompt explicitly forbids revealing model vendors, gateway architecture, or tool implementation details. Probing attempts are gracefully deflected.

## What's gone (vs. v1)

- `mini-services/zrouter/` — deleted. No more sidecar gateway.
- `concurrently` — removed. Only one process now.
- `bun-types` + Bun runtime — removed. Rara builds with `node:22-alpine` and runs with `node server.js`.
- `KROUTER_INTERNAL_TOKEN` — no-op. The shared secret between Next.js and zrouter is no longer needed.
- The key pool, virtual keys, proxy manager — all gone. Rara uses opencode.ai's free tier directly.
- The MCP server + admin tools (`krouter_status`, `krouter_usage`, etc.) — kept in the system prompt as a graceful "not available" message. Use the admin panel UI for user/conversation management instead.

## Roadmap

- ✅ Self-contained Next.js + opencode.ai free tier.
- ✅ React DOM `removeChild` fix (split imperative + React-managed containers).
- ✅ Hiura VTuber character with 6 mood expressions.
- ✅ Bundled Dockerfile + docker-compose + PM2 config.
- 🔜 Tool-call persona translation testing (verify the persona map still works against the latest opencode.ai backend).
- 🔜 Optional: add a second free-tier provider (Groq free) as a fallback when opencode.ai returns 429.

## Credits

- **opencode.ai** — the free-tier AI gateway that powers Rara. Visit https://opencode.ai to upgrade to a paid account.
- **Hiura character art** — VTuber-style fan art (originally from the Hiura vtuber project).
