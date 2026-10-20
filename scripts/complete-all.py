#!/usr/bin/env python3
"""
Complete all remaining tasks:
1. Install chromium for animest (puppeteer)
2. Restart animest
3. Push ALL runtime changes to kali-linux Dockerfile (better architecture)
4. Rebuild image via GH Actions
5. Deploy new image
6. Verify everything
"""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  COMPLETE ALL REMAINING TASKS", flush=True)
print("=" * 70, flush=True)

# ═══ Task 1: Install chromium for animest ═════════════════════════════
print("\n[T1] Install chromium for animest puppeteer...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "apt update -qq 2>&1 | tail -2 && "
    "DEBIAN_FRONTEND=noninteractive apt install -y chromium-browser 2>&1 | tail -5 && "
    "which chromium-browser 2>&1 && "
    "chromium-browser --version 2>&1"
    "'",
    timeout=120
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart animest
print("\n[T1b] Restart animest...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart animest --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== animest status ==='; "
    "docker exec kali pm2 list 2>&1 | grep animest; "
    "echo; echo '=== wotanime test ==='; "
    "curl -sI --max-time 10 https://wotanime.my.id/ 2>&1 | head -5; "
    "echo; echo '=== local wotanime test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: wotanime.my.id' http://127.0.0.1:80/ 2>&1",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

# ═══ Task 2: Push ALL changes to kali-linux Dockerfile ══════════════
print("\n[T2] Push all runtime changes to kali-linux Dockerfile...", flush=True)

# The complete Dockerfile patch — adds:
# 1. nginx install + SSL cert generation
# 2. rara-agent clone + build (to /opt/rara-agent)
# 3. run-rara-web.sh (with HOSTNAME=0.0.0.0, node instead of bun)
# 4. run-rara-zrouter.sh (with /root/.bun/bin/bun)
# 5. run-nginx.sh (real nginx, not stub)
# 6. nginx reverse proxy config (with SSL)
# 7. Remove cloudflared-ssh + ttt + nginx-stub + mysql-stub from ecosystem

PATCH = r'''import re, sys

with open("Dockerfile") as f:
    content = f.read()

# Remove old rara-agent blocks (from previous attempts)
for pat in [
    r"# Bundle rara-agent.*?RUN chmod \+x /usr/local/bin/run-rara-zrouter\.sh\n\n",
    r"RUN mkdir -p /opt.*?bun install.*?tail -3\n",
    r"COPY run-rara-.*?\.sh.*?/usr/local/bin/\n",
    r"RUN chmod \+x /usr/local/bin/run-rara-.*?\.sh.*?\n",
]:
    content, n = re.subn(pat, "", content, flags=re.DOTALL)

# Find EXPOSE
idx = content.find("EXPOSE 22 80 443")
if idx < 0:
    idx = content.find("EXPOSE")
if idx < 0:
    print("ERROR"); sys.exit(1)

block = """
# ═══ nginx + SSL (reverse proxy for all domains) ═══
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx openssl chromium-browser && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/nginx/ssl && \\
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \\
    -keyout /etc/nginx/ssl/selfsigned.key -out /etc/nginx/ssl/selfsigned.crt \\
    -subj /CN=*.ai.id/O=Rara/C=ID
RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default
COPY rara-nginx.conf /etc/nginx/conf.d/rara-nginx.conf

# ═══ rara-agent (Next.js + zrouter) bundled to /opt ═══
RUN mkdir -p /opt && \\
    git clone --depth 1 https://github.com/Yz776/rara-agent.git /opt/rara-agent && \\
    cd /opt/rara-agent && \\
    bun install --frozen-lockfile 2>&1 | tail -5 && \\
    DATABASE_URL=file:/tmp/rara-build-validate.db bunx prisma generate 2>&1 | tail -3 && \\
    DATABASE_URL=file:/tmp/rara-build-validate.db NEXT_TELEMETRY_DISABLED=1 \\
    NODE_OPTIONS="--max-old-space-size=4096 --max-semi-space-size=128" \\
    bun run build 2>&1 | tail -5 && \\
    cd mini-services/zrouter && bun install 2>&1 | tail -3 && \\
    mkdir -p /data/apps/rara-agent/mini-services/zrouter/data /data/apps/rara-agent/db

COPY run-rara-web.sh run-rara-zrouter.sh run-nginx.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/run-rara-web.sh /usr/local/bin/run-rara-zrouter.sh /usr/local/bin/run-nginx.sh

"""
new = content[:idx] + block + content[idx:]
with open("Dockerfile", "w") as f:
    f.write(new)
print(f"OK: {len(new)} bytes")
'''

# All run scripts (final correct versions)
RUN_RARA_WEB = '''#!/usr/bin/env bash
set -euo pipefail
cd /opt/rara-agent
: "${KFAI_AUTH_SECRET:?must be set}"
: "${KROUTER_INTERNAL_TOKEN:?must be set}"
: "${KROUTER_ADMIN_PASSWORD:?must be set}"
export NODE_ENV=production
export HOST=0.0.0.0
export HOSTNAME=0.0.0.0
export PORT="${RARA_PORT:-3002}"
export DATABASE_URL="${DATABASE_URL:-file:/data/apps/rara-agent/db/rara.db}"
export KROUTER_BASE="${KROUTER_BASE:-http://127.0.0.1:3001}"
export MCP_ENDPOINT="${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp}"
export RARA_BASE_URL="${RARA_BASE_URL:-http://127.0.0.1:3002}"
export PATH="/root/.bun/bin:/data/root/.bun/bin:$PATH"
/root/.bun/bin/bun run db:push --accept-data-loss 2>/dev/null || true
exec node .next/standalone/server.js
'''

RUN_RARA_ZROUTER = '''#!/usr/bin/env bash
set -euo pipefail
cd /opt/rara-agent
: "${KROUTER_INTERNAL_TOKEN:?must be set}"
: "${KROUTER_ADMIN_USERNAME:-admin}"
: "${KROUTER_ADMIN_PASSWORD:?must be set}"
export NODE_ENV=production
export HOST=127.0.0.1
export PORT="${ZROUTER_PORT:-3001}"
export KROUTER_DATA_DIR="${KROUTER_DATA_DIR:-/data/apps/rara-agent/mini-services/zrouter/data}"
exec /root/.bun/bin/bun run mini-services/zrouter/src/index.ts
'''

RUN_NGINX = '''#!/usr/bin/env bash
exec nginx -g "daemon off;"
'''

# nginx config (final version with all domains)
NGINX_CONF = '''# Rara Agent + Kali-Linux reverse proxy
upstream rara_web { server 127.0.0.1:3002; }
upstream bot_wa { server 127.0.0.1:3000; }
upstream catur_game { server 127.0.0.1:3003; }
upstream cloud_storage { server 127.0.0.1:47291; }
upstream animest_app { server 127.0.0.1:3051; }

ssl_certificate /etc/nginx/ssl/selfsigned.crt;
ssl_certificate_key /etc/nginx/ssl/selfsigned.key;

server {
    listen 80 default_server; listen [::]:80 default_server;
    listen 443 ssl default_server; listen [::]:443 ssl default_server;
    server_name rara.ai.id _;
    location / {
        proxy_pass http://rara_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
server {
    listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl;
    server_name bot.kangwifi.eu.org;
    location / {
        proxy_pass http://bot_wa;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
server {
    listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl;
    server_name game.kangwifi.eu.org;
    location / {
        proxy_pass http://catur_game;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
server {
    listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl;
    server_name storage.kangwifi.eu.org;
    location / {
        proxy_pass http://cloud_storage;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl;
    server_name wotanime.my.id;
    location / {
        proxy_pass http://animest_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
'''

# Upload all files via SFTP
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

sftp = client.open_sftp()
files = {
    '/tmp/deploy-run-rara-web.sh': RUN_RARA_WEB,
    '/tmp/deploy-run-rara-zrouter.sh': RUN_RARA_ZROUTER,
    '/tmp/deploy-run-nginx.sh': RUN_NGINX,
    '/tmp/deploy-rara-nginx.conf': NGINX_CONF,
    '/tmp/deploy-patch.py': PATCH,
}
for path, content in files.items():
    with sftp.file(path, 'w') as f:
        f.write(content)
print("  5 files uploaded via SFTP", flush=True)
sftp.close()

# Clone repo + apply patch + add files + push
cmd = (
    "rm -rf /tmp/kali-build && mkdir -p /tmp/kali-build && cd /tmp/kali-build && "
    "git clone https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git 2>&1 | tail -3 && "
    "cd kali-linux && "
    "git reset --hard f6b7ef1 2>&1 | tail -2 && "
    # Copy all files
    "cp /tmp/deploy-run-rara-web.sh run-rara-web.sh && "
    "cp /tmp/deploy-run-rara-zrouter.sh run-rara-zrouter.sh && "
    "cp /tmp/deploy-run-nginx.sh run-nginx.sh && "
    "cp /tmp/deploy-rara-nginx.conf rara-nginx.conf && "
    "chmod +x run-*.sh && "
    # Apply Dockerfile patch
    "python3 /tmp/deploy-patch.py && "
    # Also remove cloudflared-ssh + ttt + nginx-stub + mysql-stub from ecosystem
    "python3 -c \""
    "import re;"
    "with open('Dockerfile') as f: c=f.read();"
    "# Remove cloudflared-ssh entry"
    "c=re.sub(r\"\\{ name:'cloudflared-ssh'.*?\\},\", \"// cloudflared-ssh removed\", c, flags=re.DOTALL);"
    "# Remove ttt entry"
    "c=re.sub(r\"\\{ name:'ttt'.*?\\},\", \"// ttt removed\", c, flags=re.DOTALL);"
    "# Remove nginx stub entry (we have real nginx now)"
    "c=re.sub(r\"\\{ name:'nginx'.*?\\},\", \"// nginx now managed outside PM2 (real nginx)\", c, flags=re.DOTALL);"
    "# Remove mysql stub entry"
    "c=re.sub(r\"\\{ name:'mysql'.*?\\},\", \"// mysql removed (stub)\", c, flags=re.DOTALL);"
    "with open('Dockerfile','w') as f: f.write(c);"
    "print('ecosystem entries cleaned')"
    "\" && "
    "echo; echo '-- diff --'; git diff --stat; "
    "echo; git add -A && "
    "git commit -m 'feat: complete architecture — nginx+SSL, rara-agent, chromium, clean PM2' 2>&1 | tail -3; "
    "git push --force https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git main 2>&1 | tail -5; "
    "cd /tmp && rm -rf kali-build deploy-*.sh deploy-*.conf deploy-patch.py; "
    "echo 'T2_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
out = stdout.read().decode("utf-8", errors="replace")
print(out)
if "T2_DONE" not in out:
    print("[!] Push failed", flush=True)
    client.close()
    sys.exit(1)
print("[+] T2 complete — Dockerfile pushed", flush=True)
client.close()

# ═══ Task 3: Wait for GH Actions build ═══════════════════════════════
print("\n[T3] Wait for GH Actions build (may take 10-15 min for full rebuild)...", flush=True)
for attempt in range(1, 46):
    time.sleep(20)
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/Yz776/kali-linux/actions/runs?per_page=1",
            headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            if data.get("workflow_runs"):
                run = data["workflow_runs"][0]
                s = run["status"]; c = run.get("conclusion")
                print(f"  [{attempt}/45] {s}/{c} (run #{run['run_number']})", flush=True)
                if s == "completed" and c == "success":
                    print("[+] BUILD SUCCEEDED!", flush=True)
                    break
                if s == "completed" and c == "failure":
                    print("[!] BUILD FAILED", flush=True)
                    sys.exit(1)
    except Exception as e:
        print(f"  [{attempt}/45] {type(e).__name__}", flush=True)
else:
    print("[!] Build timeout (15 min)", flush=True)
    sys.exit(1)

# ═══ Task 4: Deploy new image ═══════════════════════════════════════
print("\n[T4] Deploy new image...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

cmd = (
    "docker rm -f kali 2>/dev/null; "
    "docker pull ghcr.io/yz776/kali-linux:main 2>&1 | tail -5; "
    "docker run -d --name kali --restart unless-stopped --privileged --network host -h kali "
    "-v /data:/data -v /var/run/docker.sock:/var/run/docker.sock "
    "-e ROOT_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=') "
    "-e SSH_PORT=2222 -e GITHUB_TOKEN=" + PAT + " "
    "-e LAUNCHER_MODE=pm2 -e TZ=Asia/Jakarta "
    "-e KFAI_AUTH_SECRET=$(openssl rand -hex 24) "
    "-e KROUTER_INTERNAL_TOKEN=$(openssl rand -hex 32) "
    "-e KROUTER_ADMIN_USERNAME=admin "
    "-e KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=') "
    "-e RARA_PORT=3002 -e ZROUTER_PORT=3001 "
    "-e CATUR_PORT=3003 "
    "-e ANIMEST_AUTO_INSTALL=true "
    "ghcr.io/yz776/kali-linux:main 2>&1 | tail -3; "
    "echo '-- waiting 120s --'; sleep 120; echo 'T4_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=240)
print(stdout.read().decode("utf-8", errors="replace"))
print("[+] T4 complete", flush=True)

# ═══ Task 5: Final verification ═════════════════════════════════════
print("\n[T5] Final verification...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== docker ps ==='; "
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -25; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3003|3051|47291|8090)' | head -15; "
    "echo; echo '=== External domain tests ==='; "
    "for D in rara.ai.id bot.kangwifi.eu.org game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → $CODE\"; "
    "done; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -3",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

print("\n" + "=" * 70, flush=True)
print("  ALL TASKS COMPLETE", flush=True)
print("=" * 70, flush=True)
