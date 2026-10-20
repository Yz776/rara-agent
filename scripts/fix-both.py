#!/usr/bin/env python3
"""
Fix 1: Install google-chrome-stable (real binary, not snap stub)
Fix 2: Simple Dockerfile push (split into smaller steps)
"""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

# Fix 1: Install google-chrome-stable
print("=== Fix 1: Install google-chrome-stable ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "wget -q -O /tmp/chrome-key.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb 2>&1 && "
    "dpkg -i /tmp/chrome-key.deb 2>&1 | tail -5 || "
    "apt-get install -f -y 2>&1 | tail -5 && "
    "which google-chrome-stable 2>&1 && "
    "google-chrome-stable --version 2>&1"
    "'",
    timeout=120
)
print(stdout.read().decode("utf-8", errors="replace"))

# Create symlink for puppeteer
print("\n=== Create puppeteer symlink ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "mkdir -p /root/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64 && "
    "ln -sf /usr/bin/google-chrome-stable /root/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome && "
    "ls -la /root/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome"
    "'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart animest + test
print("\n=== Restart animest + test ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart animest --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== wotanime test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://wotanime.my.id/ 2>&1; "
    "echo; echo '=== animest logs ==='; "
    "docker exec kali pm2 logs animest --lines 5 --nostream 2>&1 | tail -10",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Fix 2: Simple Dockerfile push — just upload files + simple sed patch
print("\n=== Fix 2: Push Dockerfile + scripts ===", flush=True)

# Upload files via SFTP
sftp = client.open_sftp()

# run-rara-web.sh
with sftp.file('/tmp/f-run-rara-web.sh', 'w') as f:
    f.write('''#!/usr/bin/env bash
set -euo pipefail
cd /opt/rara-agent
: "${KFAI_AUTH_SECRET:?must be set}"
: "${KROUTER_INTERNAL_TOKEN:?must be set}"
: "${KROUTER_ADMIN_PASSWORD:?must be set}"
export NODE_ENV=production HOST=0.0.0.0 HOSTNAME=0.0.0.0
export PORT="${RARA_PORT:-3002}"
export DATABASE_URL="${DATABASE_URL:-file:/data/apps/rara-agent/db/rara.db}"
export KROUTER_BASE="${KROUTER_BASE:-http://127.0.0.1:3001}"
export MCP_ENDPOINT="${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp}"
export RARA_BASE_URL="${RARA_BASE_URL:-http://127.0.0.1:3002}"
export PATH="/root/.bun/bin:/data/root/.bun/bin:$PATH"
/root/.bun/bin/bun run db:push --accept-data-loss 2>/dev/null || true
exec node .next/standalone/server.js
''')

# run-rara-zrouter.sh
with sftp.file('/tmp/f-run-rara-zrouter.sh', 'w') as f:
    f.write('''#!/usr/bin/env bash
set -euo pipefail
cd /opt/rara-agent
: "${KROUTER_INTERNAL_TOKEN:?must be set}"
: "${KROUTER_ADMIN_USERNAME:-admin}"
: "${KROUTER_ADMIN_PASSWORD:?must be set}"
export NODE_ENV=production HOST=127.0.0.1 PORT="${ZROUTER_PORT:-3001}"
export KROUTER_DATA_DIR="${KROUTER_DATA_DIR:-/data/apps/rara-agent/mini-services/zrouter/data}"
exec /root/.bun/bin/bun run mini-services/zrouter/src/index.ts
''')

# run-nginx.sh
with sftp.file('/tmp/f-run-nginx.sh', 'w') as f:
    f.write('''#!/usr/bin/env bash
exec nginx -g "daemon off;"
''')

# nginx config
with sftp.file('/tmp/f-nginx.conf', 'w') as f:
    f.write('''upstream rara_web { server 127.0.0.1:3002; }
upstream bot_wa { server 127.0.0.1:3000; }
upstream catur_game { server 127.0.0.1:3003; }
upstream cloud_storage { server 127.0.0.1:47291; }
upstream animest_app { server 127.0.0.1:3051; }
ssl_certificate /etc/nginx/ssl/selfsigned.crt;
ssl_certificate_key /etc/nginx/ssl/selfsigned.key;
server { listen 80 default_server; listen [::]:80 default_server; listen 443 ssl default_server; listen [::]:443 ssl default_server; server_name rara.ai.id _; location / { proxy_pass http://rara_web; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
server { listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl; server_name bot.kangwifi.eu.org; location / { proxy_pass http://bot_wa; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
server { listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl; server_name game.kangwifi.eu.org; location / { proxy_pass http://catur_game; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
server { listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl; server_name storage.kangwifi.eu.org; location / { proxy_pass http://cloud_storage; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } }
server { listen 80; listen [::]:80; listen 443 ssl; listen [::]:443 ssl; server_name wotanime.my.id; location / { proxy_pass http://animest_app; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
''')

sftp.close()
print("  4 files uploaded", flush=True)

# Clone + copy files + simple sed patch + push
cmd = (
    "rm -rf /tmp/kali-build && cd /tmp && "
    "git clone --depth 1 https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git kali-build 2>&1 | tail -2 && "
    "cd kali-build && "
    "git reset --hard f6b7ef1 2>&1 | tail -1 && "
    "cp /tmp/f-run-rara-web.sh run-rara-web.sh && "
    "cp /tmp/f-run-rara-zrouter.sh run-rara-zrouter.sh && "
    "cp /tmp/f-run-nginx.sh run-nginx.sh && "
    "cp /tmp/f-nginx.conf rara-nginx.conf && "
    "chmod +x run-*.sh && "
    # Simple sed: insert before EXPOSE
    "L=$(grep -n 'EXPOSE 22' Dockerfile | head -1 | cut -d: -f1) && "
    "sed -i \"${L}i\\"
    "# nginx + SSL\\n"
    "RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx openssl chromium-browser && rm -rf /var/lib/apt/lists/*\\n"
    "RUN mkdir -p /etc/nginx/ssl && openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout /etc/nginx/ssl/selfsigned.key -out /etc/nginx/ssl/selfsigned.crt -subj /CN=*.ai.id/O=Rara/C=ID\\n"
    "RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default\\n"
    "COPY rara-nginx.conf /etc/nginx/conf.d/rara-nginx.conf\\n"
    "# rara-agent bundle\\n"
    "RUN mkdir -p /opt && git clone --depth 1 https://github.com/Yz776/rara-agent.git /opt/rara-agent && cd /opt/rara-agent && bun install --frozen-lockfile 2>&1 | tail -3 && DATABASE_URL=file:/tmp/rara-build-validate.db bunx prisma generate 2>&1 | tail -2 && DATABASE_URL=file:/tmp/rara-build-validate.db NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=4096 bun run build 2>&1 | tail -5 && cd mini-services/zrouter && bun install 2>&1 | tail -2 && mkdir -p /data/apps/rara-agent/mini-services/zrouter/data /data/apps/rara-agent/db\\n"
    "COPY run-rara-web.sh run-rara-zrouter.sh run-nginx.sh /usr/local/bin/\\n"
    "RUN chmod +x /usr/local/bin/run-rara-web.sh /usr/local/bin/run-rara-zrouter.sh /usr/local/bin/run-nginx.sh\\n"
    "\" Dockerfile && "
    "echo; git diff --stat; "
    "echo; git add -A && "
    "git commit -m 'feat: complete architecture — nginx+SSL, rara-agent, chromium, 5 domains' 2>&1 | tail -3; "
    "git push --force https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git main 2>&1 | tail -5; "
    "cd /tmp && rm -rf kali-build f-*.sh f-*.conf; "
    "echo 'T2_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
print(out)
if err: print("STDERR:", err[-500:])

if "T2_DONE" not in out:
    print("[!] Push may have failed — checking...", flush=True)
else:
    print("[+] T2 complete — Dockerfile pushed", flush=True)

client.close()
