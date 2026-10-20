#!/bin/bash
#
# KRouter — Pterodactyl install script (standalone reference)
#
# This is the same script embedded in egg-krouter.json. It is provided here as
# a separate file so you can run/test it manually inside a container:
#
#   docker run --rm -it -v "$PWD:/home/container" -w /home/container \
#     node:20-bookworm bash scripts/pterodactyl-install.sh
#
# In Pterodactyl, the panel runs this automatically when the server is created
# or reinstalled. /home/container is the persistent volume that survives
# restarts and reinstalls.
#
set -e

cd /home/container

echo "[install] === KRouter Pterodactyl installer ==="

# --- 1. Install Bun to the persistent volume so it survives restarts ----------
if [ -x "/home/container/.bun/bin/bun" ]; then
    echo "[install] Bun already installed at /home/container/.bun — skipping."
else
    echo "[install] Installing Bun to /home/container/.bun ..."
    export BUN_INSTALL="/home/container/.bun"
    curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="/home/container/.bun"
export PATH="/home/container/.bun/bin:$PATH"
echo "[install] Bun version: $(bun --version)"

# --- 2. Clone or update the KRouter repository --------------------------------
REPO_URL="${GIT_REPO_URL:-https://github.com/Yz776/zrouter.git}"
REPO_BRANCH="${GIT_REPO_BRANCH:-main}"

if [ -d "/home/container/zrouter/.git" ]; then
    echo "[install] Updating existing repository ..."
    cd /home/container/zrouter
    git remote set-url origin "$REPO_URL"
    git fetch --all --prune
    git reset --hard "origin/$REPO_BRANCH"
else
    echo "[install] Cloning $REPO_URL (branch: $REPO_BRANCH) ..."
    rm -rf /home/container/zrouter
    git clone --depth 1 -b "$REPO_BRANCH" "$REPO_URL" /home/container/zrouter
    cd /home/container/zrouter
fi

# --- 3. Prepare the persistent data directory --------------------------------
mkdir -p /home/container/data /home/container/logs
echo "[install] Data directory: /home/container/data"

# --- 4. Install dependencies (skip Puppeteer's Chromium download) -------------
# puppeteer is only used by test/login helpers in this repo, not by the runtime
# app, so we skip its large Chromium download to keep installs fast and small.
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_SKIP_DOWNLOAD=true
export BUN_ENV=production
export NODE_ENV=production

echo "[install] Running bun install ..."
bun install --production

echo "[install] === Installation complete ==="
echo "[install] KRouter is ready. Start the server from the panel."
echo "[install] Default login: admin / password123 (change it after first boot)"
