# KRouter — AI Gateway (Bun + ElysiaJS) v2.0

> A local-first OpenAI + Anthropic compatible AI gateway that routes requests to **30+ providers** with **OAuth support** (Claude/Codex/Antigravity/Gemini CLI), **DeepSeek scraper** (free, no API key), **streaming**, **tool calling**, **failover routing**, **combos**, **token saver**, **observability**, and a **dashboard**.

Inspired by [9router](https://github.com/decolua/9router) and [Zrouter](https://github.com/zelapii/Zrouter), rewritten in Bun for speed.

---

## ✨ Features

### Core API
| Feature | Description |
|---------|-------------|
| **OpenAI Chat Completions** | `POST /v1/chat/completions` — full OpenAI API compat (stream/non-stream, tools, vision, reasoning) |
| **Anthropic Messages** | `POST /v1/messages` — full Anthropic API compat (Claude Code native, Zed, Cline) |
| **Embeddings** | `POST /v1/embeddings` — OpenAI-compatible |
| **Image Generation** | `POST /v1/images/generations` — OpenAI DALL-E compat |
| **Models** | `GET /v1/models` — aggregated from all enabled providers |

### 30+ Providers
- **OAuth**: Claude (Anthropic), Codex (OpenAI ChatGPT Plus/Pro), Antigravity (Google), Gemini CLI (Google)
- **Scraped**: DeepSeek (free, no API key — PoW solver in pure JS, no WASM needed)
- **API key**: OpenAI, Groq, OpenRouter, Together, Cerebras, Fireworks, xAI, Mistral, Gemini, Cohere, Perplexity, SiliconFlow, Nebius, Hyperbolic, Chutes, GLM-CN (Zhipu), OpenCode Go ($5/mo — Kimi/GLM/Qwen/MiniMax/DeepSeek)
- **Free tier**: BluesMinds, GoRouter, SeekAI, OpenCode (no key needed — `Bearer public`, live model discovery via `/zen/v1/models`, muse-spark models auto-routed through the Responses API), LLM7 (free token at llm7.io), Kilo Gateway (free `:free` models), Kimchi
- **Self-hosted**: Ollama, LM Studio

> The OpenCode / LLM7 / Kilo / Kimchi / GLM-CN / OpenCode-Go providers are ported from [9router](https://github.com/decolua/9router) (MIT), including its `x-opencode-*` identity-header scheme and Chat→Responses translation for muse-spark models. **OpenCode free-tier gate (big-pickle, `*-free` models):** opencode.ai's Console backend rejects any free-tier request that doesn't carry the exact system prompt + tool set the real OpenCode client sends (`403 FreeTierError`). KRouter's `OpenCodeExecutor` wraps every no-key request with that captured persona (system prompt + 11-tool set + `stream:true`), folds your real instructions into the first user message, and translates the model's tool calls back to your client's tool names/args — so `opencode/big-pickle` and the other free models work from any OpenAI/Anthropic-compatible client, including agentic tool-calling loops. Pass your own opencode.ai key to unlock premium models.

### Routing & Reliability
| Feature | Description |
|---------|-------------|
| **Fallback routing** | Configurable: model A → model B on `429/503/...` with regex message matching |
| **Combos / fusion** | Named aliases backed by ordered model lists; `fallback` or `round-robin` strategy; capability-aware auto-switch |
| **Fail-open token saver** | Best-effort, never breaks request — git diff/grep/ls/log/build output compression |
| **Capability shims** | Auto-drops `tools` for unsupported models; auto-clamps `max_tokens` on 400 |
| **OAuth refresh sweeper** | Background task refreshes tokens before expiry (per-provider lead times: claude 4h, codex 5d, google 5m) |
| **Per-credential dedup** | Concurrent requests on the same expired token share one refresh |

### Token Saver (prompt compression)
4-pass pipeline applied before sending upstream:
1. **Compress tool output** — auto-detect git diff/status/log, grep, ls, tree, build output, dedup logs, smart truncate
2. **System-prompt injection** — lazy senior dev (YAGNI) + terse output mode
3. **Per-message truncation** — strips oversized messages
4. **Trim messages** — replaces oldest tool messages with placeholders

### Observability
- **SQLite-backed request logs** — tokens, cost, latency, fallback audit (path + reason)
- **Per-API-key usage tracking** — tokens + USD cost
- **Per-model breakdown** — top N models by requests/tokens
- **Usage summary** — total requests, tokens, avg latency, error count, fallback count
- **Live log viewer** in dashboard

### Virtual API Keys
Per-key scoped credentials with:
- **Rate limit** (req/min, fixed window)
- **Quota limit** (lifetime tokens)
- **Credit limit** (USD)
- **Allowed models** (with `*` wildcard, e.g. `groq/*`, `ollama/mock-*`)
- **Real-time usage tracking**

### Tool Interceptor
- Auto-intercepts `web_search` / `google_search` / `brave_search` / `web_fetch` tool calls when client didn't declare them
- Executes search server-side (DuckDuckGo HTML scrape, no API key required)
- Re-invokes model with depth+1 (max 3) — agent sees final answer, no extra round-trip
- Streams buffered until tool calls complete, then decides to intercept

### Cloudflare Tunnel
- Expose local gateway via public URL without opening ports
- Quick tunnel (random `*.trycloudflare.com`) or named tunnel (Cloudflare Zero Trust)
- Auto-restart with exponential backoff (max 5 attempts, 30s cap)
- Live SSE status stream in dashboard
- Autostart on boot option

### Dashboard
Full admin SPA at `/` with 9 tabs:
1. **Providers** — configure 25+ providers, OAuth connect buttons
2. **API Keys** — admin keys for full access
3. **Virtual Keys** — scoped keys with rate limits + quotas
4. **Fallbacks** — model A → B rules
5. **Combos** — fusion model aliases
6. **Logs** — recent request log viewer
7. **Usage** — summary stats + per-model breakdown
8. **Token Saver** — prompt compression settings
9. **OAuth** — connection status for Claude/Codex/Antigravity/Gemini CLI
10. **Tunnel** — Cloudflare tunnel management

---

## 🚀 Quick start

```bash
cd /home/user/my-project/krouter
bun install
bun run dev   # http://localhost:3000
```

**First-time setup:** Open `http://localhost:3000/login.html` and login with default credentials:
- **Username:** `admin`  
- **Password:** `password123`

⚠️ **IMPORTANT:** Change the default password after first login via the User Settings section!

After logging in, you'll get a session cookie that gives full access to the dashboard where you can:
- Create admin API keys (`kr-...`)
- Configure providers (OAuth or API key)
- Generate scoped virtual keys with rate limits and quotas

---

## 🔌 Using with AI agents

### Claude Code (Anthropic native)
```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=kr-...
# Claude Code uses /v1/messages — full Anthropic protocol
```

### Cursor / Cline / Continue / Codex / OpenCode (OpenAI compat)
```
Base URL: http://localhost:3000/v1
API Key: kr-...
```

### Plain curl
```bash
# OpenAI format
curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer kr-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"Hi"}],"stream":true}'

# Anthropic format
curl -N http://localhost:3000/v1/messages \
  -H "Authorization: Bearer kr-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"claude/claude-sonnet-4-20250514","max_tokens":1024,"messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

---

## 🎯 Model naming

All models use `provider/model` format. Use `combo/<name>` for fusion models.

| Model ID | Provider |
|----------|----------|
| `deepseek/deepseek-chat` | DeepSeek scraper (free) |
| `opencode/big-pickle` | OpenCode free tier (no key — persona wrapper bypasses the "within OpenCode" gate, full tool-calling) |
| `llm7/gpt-5.5` | LLM7 free token |
| `opencode-go/glm-5.3` | OpenCode Go subscription |
| `claude/claude-sonnet-4-20250514` | Anthropic OAuth (Claude Code subscription) |
| `codex/gpt-4o` | OpenAI OAuth (ChatGPT Plus/Pro) |
| `antigravity/gemini-2.5-pro` | Google Antigravity OAuth |
| `groq/llama-3.3-70b-versatile` | Groq API |
| `ollama/llama3.2` | Local Ollama |
| `combo/fast-coder` | Custom combo alias |

---

## 🔑 DeepSeek scraper setup

1. Open https://chat.deepseek.com and log in
2. DevTools → Network → send any chat message
3. Find request to `/api/v0/chat/completion`, copy the `Authorization: Bearer ...` value
4. Dashboard → Providers → DeepSeek → paste token

The gateway solves the Proof-of-Work challenge (SHA-3 in pure JS), creates a chat session, parses the non-standard SSE stream, and re-emits it as standard OpenAI format.

---

## 🔐 OAuth setup

OAuth providers (Claude, Codex, Antigravity, Gemini CLI) don't need an API key — they use your existing subscription:

1. Dashboard → Providers → click "Connect via OAuth" on the provider card
2. Browser opens the provider's authorize URL
3. Approve → redirected back to `/admin/oauth/callback`
4. Gateway exchanges the code for tokens, stores them, and refreshes them automatically

Per-provider refresh lead times:
- **Claude**: 4 hours before expiry
- **Codex**: 5 days (8 day max refresh age)
- **Antigravity / Gemini CLI**: 5 minutes

---

## 📡 API reference

### Chat
- `POST /v1/chat/completions` — OpenAI Chat Completions
- `POST /v1/messages` — Anthropic Messages
- `POST /v1/embeddings` — OpenAI Embeddings
- `POST /v1/images/generations` — OpenAI Image Gen
- `GET /v1/models` — Aggregated model list

### Admin
- `GET /admin/api/status` — Bootstrap status
- `GET/POST/DELETE /admin/api/keys` — Admin keys
- `GET/POST/DELETE /admin/api/virtual-keys` — Virtual keys (with rate limits + quotas)
- `GET/POST/DELETE /admin/api/providers` — Provider credentials
- `POST /admin/api/providers/:id/test` — Test provider connection
- `GET/POST/DELETE /admin/api/fallbacks` — Fallback rules
- `GET/POST/DELETE /admin/api/combos` — Combos / fusion aliases
- `GET /admin/api/usage` — Usage summary + per-model breakdown
- `GET /admin/api/logs` — Recent request logs
- `GET/POST /admin/api/token-saver` — Token saver settings

### OAuth
- `GET /admin/oauth/providers` — List OAuth providers
- `POST /admin/oauth/connect/:providerId` — Get authorize URL
- `GET /admin/oauth/callback` — OAuth callback (provider redirects here)
- `DELETE /admin/oauth/disconnect/:providerId` — Disconnect
- `GET /admin/oauth/status/:providerId` — Connection status

### Tunnel
- `GET /admin/api/tunnel/status` — Tunnel state
- `GET /admin/api/tunnel/events` — SSE stream of status updates
- `POST /admin/api/tunnel/start` — Start tunnel
- `POST /admin/api/tunnel/stop` — Stop tunnel
- `PATCH /admin/api/tunnel` — Update config (token, domain, autostart)

---

## 🏗️ Architecture

```
src/
├── index.ts                     # Elysia server entry
├── types/
│   ├── index.ts                 # OpenAI-compatible types
│   └── anthropic.ts             # Anthropic Messages types
├── utils/
│   ├── stream.ts                # SSE parsing, line iterators
│   └── retry.ts                 # fetchWithRetry, transient error detection
├── executors/
│   ├── openai.ts                # Generic OpenAI-compatible executor
│   └── deepseek-scraper.ts      # DeepSeek web scraper with PoW solver
├── providers/
│   └── catalog.ts               # 25+ provider definitions + factory
├── services/
│   ├── registry.ts              # Executor cache + model routing
│   ├── config-store.ts          # Disk-backed JSON config
│   ├── fallback.ts              # Failover rule engine
│   ├── combos.ts                # Combo/fusion aliases
│   ├── translator.ts            # OpenAI ↔ Anthropic translator
│   ├── token-saver.ts           # Prompt compression pipeline
│   ├── rtk-filters.ts           # 11 RTK output filters + auto-detect
│   ├── token-refresh.ts         # OAuth refresh sweeper
│   ├── oauth.ts                 # OAuth PKCE + token exchange
│   ├── tool-interceptor.ts      # Web search/fetch interceptor
│   ├── db.ts                    # SQLite logging + virtual keys
│   └── cloudflare-tunnel.ts     # Cloudflare tunnel manager
├── middleware/
│   ├── auth.ts                  # Admin + virtual key auth
│   └── rate-limit.ts            # Fixed-window rate limiter + quota check
└── routes/
    ├── chat.ts                  # POST /v1/chat/completions
    ├── messages.ts              # POST /v1/messages (Anthropic)
    ├── embeddings.ts            # POST /v1/embeddings
    ├── images.ts                # POST /v1/images/generations
    ├── models.ts                # GET /v1/models
    ├── admin.ts                  # /admin/api/* REST API
    ├── oauth.ts                  # /admin/oauth/* OAuth flow
    └── tunnel.ts                # /admin/api/tunnel/* Cloudflare

public/
└── index.html                   # Dashboard SPA (10 tabs, vanilla JS)
```

---

## 🧪 Testing

```bash
bun run dev          # start gateway on :3000
bun run test/mock-upstream.ts  # start mock OpenAI server on :4123 (separate terminal)
bash test/integration.sh       # full end-to-end test
```

Tests cover:
- Bootstrap key creation + auth enforcement
- OpenAI Chat Completions (stream + non-stream + tool calls)
- Anthropic Messages (stream + non-stream + tools + thinking)
- Embeddings API
- Virtual API keys (creation, rate limit, quota, model access)
- Combos (creation, lookup by name, fallback/round-robin)
- Fallback rules (model A → B on status codes)
- Token saver (config + apply)
- Logs / observability (SQLite insert + query)
- OAuth providers (list, status)
- Cloudflare tunnel (status)

---

## 📜 License

MIT

---

## 🏢 Production Deployment

### Quick Start (Recommended)

#### Option 1: Docker Compose (Easiest)

```bash
# Copy environment template
cp .env.example .env
nano .env  # Edit your secrets

# Start with one command
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs -f krouter

# Stop
docker-compose down
```

#### Option 2: PM2 Process Manager

```bash
# Install Bun & PM2
npm install -g bun pm2

# Create directories
mkdir -p /var/log/krouter /var/lib/krouter/data

# Setup environment
cat > .env << EOF
KROUTER_DB_PATH=/var/lib/krouter/data/krouter.db
JWT_SECRET=$(openssl rand -hex 32)
PORT=3000
EOF

# Run with PM2
pm2 start pm2.config.cjs
pm2 save
pm2 startup  # Add to system startup

# Monitor
pm2 status
pm2 logs krouter
pm2 monit
```

### Detailed Deployment Guides

#### A. Local Server (Linux/macOS/Windows)

**Step 1:** Install dependencies
```bash
curl -fsSL https://bun.sh/install | bash
cd /path/to/zrouter
bun install --production
```

**Step 2:** Configure environment
```bash
cp .env.example .env
nano .env

# Set required values:
export PORT=3000
export JWT_SECRET=$(openssl rand -hex 32)
export KROUTER_DB_PATH=~/.krouter/krouter.db
```

**Step 3:** Run in production
```bash
# Development (with hot reload)
bun run dev

# Production
NODE_ENV=production bun run src/index.ts

# Or use PM2
pm2 start src/index.ts --name krouter --interpreter bun
pm2 save
```

#### B. Cloud Deployments

##### DigitalOcean Droplet

```bash
# SSH into droplet
ssh root@your-droip-ip

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Clone repo
git clone https://github.com/Yz776/zrouter.git /opt/krouter
cd /opt/krouter

# Setup PM2
npm install -g pm2
pm2 start pm2.config.cjs
pm2 save
pm2 startup

# Configure firewall
ufw allow 3000/tcp
ufw enable

# Access dashboard
http://your-droip-ip:3000
```

##### AWS EC2

```bash
# Launch Ubuntu EC2 instance
# Connect via SSH

# Install Bun & dependencies
sudo apt update && sudo apt install -y git curl unzip
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Deploy application
cd ~
git clone https://github.com/Yz776/zrouter.git
cd zrouter
bun install --production
pm2 start pm2.config.cjs
pm2 save

# Configure AWS Security Group
# Allow port 3000 from your IP only
```

##### VPS (Hetzner, OVH, Linode)

Same steps as DigitalOcean, just adjust firewall rules:
```bash
# UFW (Ubuntu/Debian)
ufw allow 3000/tcp

# firewalld (CentOS/RHEL)
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --reload
```

#### C. Docker Deployment

**Single Container:**
```bash
# Build image
docker build -t krouter:latest .

# Run container
docker run -d \
  --name krouter-gateway \
  --restart unless-stopped \
  -p 3000:3000 \
  -v krouter_data:/app/data \
  -v krouter_logs:/app/logs \
  -e PORT=3000 \
  -e JWT_SECRET=your-secret-key-here \
  -e NODE_ENV=production \
  krouter:latest
```

**Using docker-compose.yml:**
```bash
# First time setup
docker-compose up -d --build

# Update service
docker-compose pull
docker-compose up -d

# Logs
docker-compose logs -f krouter

# Rollback previous version
docker-compose up -d --no-deps --force-recreate krouter
```

#### D. Cloudflare Tunnel (No Port Forwarding)

```bash
# Install cloudflared on server
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Configure tunnel
cloudflared tunnel create krouter
cloudflared tunnel config add

# Start tunnel
cloudflared tunnel run krouter

# Access via HTTPS: https://your-subdomain.cfargotunnel.com
```

### Environment Variables Reference

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | `3000` | No |
| `HOST` | Server bind address | `0.0.0.0` | No |
| `KROUTER_DB_PATH` | SQLite database path | `~/.krouter/krouter.db` | No |
| `JWT_SECRET` | Session encryption key | auto-generated | Yes |
| `LOG_LEVEL` | Debug verbosity | `info` | No |
| `RATE_LIMIT_PER_MINUTE` | Requests per minute | `60` | No |
| `SESSION_COOKIE_SECURE` | Force HTTPS cookies | `true` | No |

### Security Hardening Checklist

- ✅ **Change default password** `admin/password123` immediately after first login
- ✅ **Use HTTPS/SSL certificate** - let's encrypt or Cloudflare
- ✅ **Set strong JWT secret** - minimum 32 characters random string
- ✅ **Bind to localhost if only local access** - `HOST=127.0.0.1`
- ✅ **Enable rate limiting** - protect against abuse
- ✅ **Use Cloudflare Tunnel** instead of opening ports directly
- ✅ **Regular backups** - backup `/app/data` directory weekly
- ✅ **Monitor logs** - set up alerts for failed logins
- ✅ **Update regularly** - `git pull && bun install && pm2 restart krouter`
- ✅ **Disable unused providers** - reduce attack surface

### Performance Tuning

```bash
# Production optimization
export BUN_ENV=production
export NODE_ENV=production

# Increase connection limits (in index.ts if needed)
# Max request body: MAX_REQUEST_BODY_SIZE=10mb

# Memory management
pm2 max-memory-restart 1G
```

### Monitoring & Logging

```bash
# View process status
pm2 status
pm2 monit

# Follow logs
pm2 logs krouter

# Health check
curl http://localhost:3000/health

# Error logs
tail -f /var/log/krouter/krouter-error.log

# Access logs (from browser console or proxy)
journalctl -u krouter -f
```

### Backup Strategy

```bash
# Create backup script /usr/local/bin/backup-krouter.sh
#!/bin/bash
BACKUP_DIR="/var/backups/krouter"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
tar -czf "$BACKUP_DIR/krouter_$TIMESTAMP.tar.gz" /var/lib/krouter/data/krouter.db
find "$BACKUP_DIR" -mtime +7 -delete  # Keep 7 days
```

Add to crontab:
```bash
0 2 * * * /usr/local/bin/backup-krouter.sh >> /var/log/backup-krouter.log 2>&1
```

---

## 🔐 Security Best Practices

1. **Change default admin password immediately** after first login
2. **Use strong API keys** - `kr-` keys are 48 chars random hex
3. **Rate limit virtual keys** for production clients
4. **Set credit limits** to prevent runaway costs
5. **Use Cloudflare Tunnel** instead of opening ports directly
6. **Regular backups** - config file is just JSON, easy to backup
7. **Monitor logs** - check `/admin` dashboard for suspicious activity
8. **Rotate keys** - delete old API keys, create new ones periodically
