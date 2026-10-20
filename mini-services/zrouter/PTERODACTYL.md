# KRouter on Pterodactyl Panel

This guide explains how to run the KRouter AI Gateway inside a
[Pterodactyl](https://pterodactyl.io/) game-server panel. Pterodactyl is a
self-hosted container manager: each "server" you create is an isolated Docker
container with a persistent volume at `/home/container`, an auto-assigned port,
and a startup command defined by an **Egg**.

KRouter ships with a ready-to-import egg, so the whole deploy is:

1. Import the egg into the panel.
2. Create a new server from that egg.
3. (The panel installs Bun + clones the repo automatically.)
4. Click **Start**.

---

## What changed for Pterodactyl support

| Change | Why |
|--------|-----|
| `src/services/paths.ts` (new) | Single helper that resolves the data directory. Honors `KROUTER_DATA_DIR`, then `KROUTER_DB_PATH`'s parent, then `~/.krouter`, then `/tmp/.krouter`. All SQLite DBs + `config.json` now live under one configurable root. |
| `db.ts`, `config-store.ts`, `auth-user.ts`, `proxy-manager.ts` | Use `paths.dataFile()` instead of hard-coded `~/.krouter/...`. Backwards-compatible: existing `KROUTER_DB_PATH` / `KROUTER_CONFIG_PATH` overrides still work. |
| `src/index.ts` | Listens on `SERVER_PORT` (Pterodactyl convention) falling back to `PORT`, then `3000`. Binds to `HOST` (defaults to `0.0.0.0`, required for Pterodactyl port forwarding). The boot banner now prints the bind host + data dir. |
| `ensureDefaultAdmin()` | Respects `KROUTER_ADMIN_USERNAME` / `KROUTER_ADMIN_PASSWORD` so the panel can provision a secure admin without shipping `admin/password123`. Falls back to the old default if unset. |
| `egg-krouter.json` (new) | The Pterodactyl egg — docker image, startup command, install script, and user-configurable variables. |
| `Dockerfile.pterodactyl` (new) | Optional pre-built image with Bun baked in (skip the per-install Bun download). |
| `scripts/pterodactyl-install.sh` (new) | Standalone copy of the install script embedded in the egg, for manual testing. |

---

## Quick start (panel import)

### Step 1 — Import the egg

1. Log in to your Pterodactyl **admin** panel.
2. Go to **Nests** → pick an existing nest (or create one called *AI Gateways*).
3. Click **Import Egg**, choose `egg-krouter.json` from this repo, and import.
4. The egg will appear with the name **KRouter AI Gateway**.

### Step 2 — Create a server

1. Go to **Servers** → **Create New**.
2. Pick the KRouter egg.
3. Choose a node and a **port allocation** (Pterodactyl auto-fills `SERVER_PORT`).
4. Set the **JWT Secret** variable to a strong random string (≥32 chars).
5. Optionally set **Admin Username** and **Admin Password** to pre-seed a secure
   admin (otherwise `admin` / `password123` is created — **change it immediately**).
6. Click **Create**. The install script runs automatically — it installs Bun to
   `/home/container/.bun`, clones the repo to `/home/container/zrouter`, and runs
   `bun install`. Takes ~30–60s.

### Step 3 — Start & access

1. Click **Start** on the server.
2. Watch the console — when you see `Listening on  http://localhost:<port>`,
   the gateway is ready.
3. Open `http://<your-node-ip>:<port>/login.html` and log in.
4. Create API keys and configure providers from the dashboard.

---

## How persistence works

Pterodactyl mounts a persistent volume at `/home/container`. Anything outside
that directory is lost when the container restarts or the server is reinstalled.
The egg is wired so that **all** KRouter state survives:

| Path | Contents |
|------|----------|
| `/home/container/data/krouter.db` | Request logs, API keys, virtual keys, usage |
| `/home/container/data/auth.db` | Users + sessions |
| `/home/container/data/config.json` | Providers, fallbacks, combos |
| `/home/container/data/proxies.db` | Proxy pool |
| `/home/container/.bun/` | Bun runtime (so reinstalls are instant) |
| `/home/container/zrouter/` | The app code itself |

The `KROUTER_DATA_DIR` variable defaults to `/home/container/data` — you usually
do not need to change it.

---

## Variables exposed by the egg

These appear in the panel's **Startup** tab when you edit the server:

| Variable | Editable | Default | Purpose |
|----------|----------|---------|---------|
| `SERVER_PORT` | No | `3000` | Auto-assigned by Pterodactyl allocation. |
| `HOST` | No | `0.0.0.0` | Bind interface. Must be `0.0.0.0` for Pterodactyl. |
| `KROUTER_DATA_DIR` | No | `/home/container/data` | Root for all persistent state. |
| `GIT_REPO_URL` | Yes | `https://github.com/Yz776/zrouter.git` | Repo to clone (use a fork or private repo). |
| `GIT_REPO_BRANCH` | Yes | `main` | Branch to clone. |
| `JWT_SECRET` | Yes | `change-me-...` | Session cookie signing secret. Set a strong value! |
| `NODE_ENV` | No | `production` | Bun/Node environment. |
| `RATE_LIMIT_MAX_REQUESTS` | Yes | `100` | Per-key requests / minute. |
| `KROUTER_ADMIN_USERNAME` | Yes | *(empty → `admin`)* | Custom admin username (fresh installs only). |
| `KROUTER_ADMIN_PASSWORD` | Yes | *(empty → `password123`)* | Custom admin password (fresh installs only). |

---

## Updating KRouter

To pull the latest code from the repo:

1. Panel → **Settings** → **Reinstall**. This re-runs the install script, which
   does `git pull` (fast-forward) and `bun install`. Persistent data is untouched.
2. Click **Restart**.

For a custom branch / fork, change `GIT_REPO_URL` and/or `GIT_REPO_BRANCH` in
the **Startup** tab, then reinstall.

---

## Option A vs Option B: which Docker image?

The egg ships configured for **Option A** (works out of the box, no image build).

### Option A — yolks Node image + Bun installed per-server (default)

- Image: `ghcr.io/pterodactyl/yolks:nodejs_22`
- Bun is installed to `/home/container/.bun` during the install script.
- ✅ No image build or registry push required.
- ⚠️ First install is ~30s slower (downloads Bun once; cached on reinstall).

### Option B — pre-built Bun image (faster, advanced)

1. Build and push `Dockerfile.pterodactyl`:

   ```bash
   docker build -f Dockerfile.pterodactyl -t ghcr.io/YOUR_USER/krouter-ptero:latest .
   docker push ghcr.io/YOUR_USER/krouter-ptero:latest
   ```

2. Edit `egg-krouter.json` → `docker_images`:

   ```json
   "docker_images": {
     "KRouter": "ghcr.io/YOUR_USER/krouter-ptero:latest"
   }
   ```

3. Re-import the egg (or edit the existing one in the panel).
4. Edit the egg's startup command to drop the PATH prefix (Bun is system-wide
   in the custom image):

   ```
   cd /home/container/zrouter && exec bun run src/index.ts
   ```

- ✅ Faster first-boot (no Bun download).
- ⚠️ You must host the image on a registry wings can pull from.

---

## Manual install script test

You can run the exact install script the panel uses, locally, inside a throwaway
container:

```bash
docker run --rm -it \
  -v "$PWD:/home/container" \
  -w /home/container \
  -e GIT_REPO_URL=https://github.com/Yz776/zrouter.git \
  node:20-bookworm \
  bash /home/container/scripts/pterodactyl-install.sh
```

This is useful for debugging install failures without going through the panel.

---

## Troubleshooting

**Server won't start — `bun: command not found`**
The install script installs Bun to `/home/container/.bun/bin`. The egg's startup
command adds that to `PATH`. If you edited the startup command, make sure it
still begins with `export PATH="/home/container/.bun/bin:$PATH" && ...`.

**Port already in use / can't connect**
Pterodactyl auto-assigns `SERVER_PORT` from the server's primary allocation. Do
not hard-code `PORT` in the startup command — the app already reads
`SERVER_PORT`. Check the **Allocations** tab for the assigned port.

**`git clone` fails in the install script**
Make sure the node running wings has outbound internet access. For private
repos, switch `GIT_REPO_URL` to an HTTPS-token URL or use a public fork.

**Data resets on restart**
Confirm `KROUTER_DATA_DIR` is `/home/container/data` (the persistent volume).
If you accidentally pointed it elsewhere inside the container (e.g. `/app/data`),
that path is ephemeral and will be wiped on restart.

**`bun install` downloads Chromium (huge)**
The install script sets `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`. If you forked
the repo and changed `package.json`, make sure puppeteer is not imported by the
runtime code — it's only used by `test-login.js`.

**Want HTTPS in front of KRouter?**
Put a reverse proxy (Caddy, Nginx, Traefik) in front of the Pterodactyl node
and terminate TLS there. KRouter itself serves plain HTTP — that's fine inside
the panel's network. Set `SESSION_COOKIE_SECURE=false` if you access it over
plain HTTP (otherwise cookies won't stick).

---

## Environment variable reference (Pterodactyl-relevant)

| Variable | Default | Notes |
|----------|---------|-------|
| `SERVER_PORT` | `3000` | Auto-set by Pterodactyl. |
| `PORT` | *(unset)* | Legacy fallback; `SERVER_PORT` wins. |
| `HOST` | `0.0.0.0` | Must be `0.0.0.0` in Pterodactyl. |
| `KROUTER_DATA_DIR` | `/home/container/data` | All persistent state. |
| `KROUTER_DB_PATH` | *(unset)* | Overrides DB file location (rare). |
| `KROUTER_CONFIG_PATH` | *(unset)* | Overrides config.json location (rare). |
| `JWT_SECRET` | *(must set)* | Session cookie signing. |
| `KROUTER_ADMIN_USERNAME` | `admin` | Fresh-install only. |
| `KROUTER_ADMIN_PASSWORD` | `password123` | Fresh-install only. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Per-key / minute. |
| `NODE_ENV` / `BUN_ENV` | `production` | Runtime mode. |
