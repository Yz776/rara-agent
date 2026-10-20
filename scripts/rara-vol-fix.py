#!/usr/bin/env python3
"""
Fix: clone rara-agent to /opt/rara-agent (outside /data volume mount).
The -v /data:/data mount shadows /data/apps/rara-agent at runtime.
"""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

# Updated scripts — use /opt/rara-agent instead of /data/apps/rara-agent
SCRIPTS = {
    'run-rara-web.sh': '''#!/usr/bin/env bash
set -euo pipefail
RARA_DIR="${RARA_DIR:-/opt/rara-agent}"
cd "$RARA_DIR"
: "${KFAI_AUTH_SECRET:?KFAI_AUTH_SECRET must be set}"
: "${KROUTER_INTERNAL_TOKEN:?KROUTER_INTERNAL_TOKEN must be set}"
: "${KROUTER_ADMIN_PASSWORD:?KROUTER_ADMIN_PASSWORD must be set}"
export NODE_ENV=production HOST=0.0.0.0 PORT="${RARA_PORT:-3002}"
export DATABASE_URL="${DATABASE_URL:-file:/data/apps/rara-agent/db/rara.db}"
export KROUTER_BASE="${KROUTER_BASE:-http://127.0.0.1:3001}"
export MCP_ENDPOINT="${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp}"
export RARA_BASE_URL="${RARA_BASE_URL:-http://127.0.0.1:3002}"
bun run db:push --accept-data-loss 2>/dev/null || true
exec bun .next/standalone/server.js
''',
    'run-rara-zrouter.sh': '''#!/usr/bin/env bash
set -euo pipefail
RARA_DIR="${RARA_DIR:-/opt/rara-agent}"
cd "$RARA_DIR"
: "${KROUTER_INTERNAL_TOKEN:?KROUTER_INTERNAL_TOKEN must be set}"
: "${KROUTER_ADMIN_USERNAME:-admin}"
: "${KROUTER_ADMIN_PASSWORD:?KROUTER_ADMIN_PASSWORD must be set}"
export NODE_ENV=production HOST=127.0.0.1 PORT="${ZROUTER_PORT:-3001}"
export KROUTER_DATA_DIR="${KROUTER_DATA_DIR:-/data/apps/rara-agent/mini-services/zrouter/data}"
exec bun run mini-services/zrouter/src/index.ts
''',
    'run-nginx.sh': '#!/usr/bin/bash\nexec sleep infinity\n',
    'run-mysql.sh': '#!/usr/bin/bash\nexec sleep infinity\n',
}

# Patch: clone to /opt/rara-agent instead of /data/apps/rara-agent
PATCH = '''import sys
with open("Dockerfile") as f:
    content = f.read()

idx = content.find("EXPOSE 22 80 443")
if idx < 0:
    idx = content.find("EXPOSE")
if idx < 0:
    print("ERROR: EXPOSE not found")
    sys.exit(1)

block = """
# Bundle rara-agent into /opt/rara-agent (NOT /data — /data is volume-mounted at runtime)
RUN mkdir -p /opt && \\\\
    git clone --depth 1 https://github.com/Yz776/rara-agent.git /opt/rara-agent && \\\\
    cd /opt/rara-agent && \\\\
    bun install --frozen-lockfile 2>&1 | tail -5 && \\\\
    DATABASE_URL=file:/tmp/rara-build-validate.db bunx prisma generate 2>&1 | tail -3 && \\\\
    DATABASE_URL=file:/tmp/rara-build-validate.db NEXT_TELEMETRY_DISABLED=1 bun run build 2>&1 | tail -5 && \\\\
    cd mini-services/zrouter && bun install 2>&1 | tail -3 && \\\\
    mkdir -p /data/apps/rara-agent/mini-services/zrouter/data /data/apps/rara-agent/db

COPY run-rara-web.sh run-rara-zrouter.sh run-nginx.sh run-mysql.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/run-rara-web.sh /usr/local/bin/run-rara-zrouter.sh /usr/local/bin/run-nginx.sh /usr/local/bin/run-mysql.sh

"""

new = content[:idx] + block + content[idx:]
with open("Dockerfile", "w") as f:
    f.write(new)
print(f"OK: {len(new)} bytes")
'''

print("=" * 70, flush=True)
print("  FIX: clone rara-agent to /opt (not /data — volume shadow issue)", flush=True)
print("=" * 70, flush=True)

# Step 1: Upload + patch + push
print("\n[1/4] Upload scripts + patch + push...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

sftp = client.open_sftp()
for name, content in SCRIPTS.items():
    with sftp.file(f'/tmp/{name}', 'w') as f:
        f.write(content)
with sftp.file('/tmp/patch-vol.py', 'w') as f:
    f.write(PATCH)
print("  5 files uploaded", flush=True)
sftp.close()

cmd = (
    "rm -rf /tmp/kali-build && mkdir -p /tmp/kali-build && cd /tmp/kali-build && "
    "git clone https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git 2>&1 | tail -3 && "
    "cd kali-linux && "
    "git reset --hard f6b7ef1 2>&1 | tail -2 && "
    "cp /tmp/run-rara-web.sh /tmp/run-rara-zrouter.sh /tmp/run-nginx.sh /tmp/run-mysql.sh . && "
    "chmod +x run-*.sh && "
    "python3 /tmp/patch-vol.py && "
    "echo; git diff --stat; "
    "echo; git add -A && "
    "git commit -m 'fix: clone rara-agent to /opt (avoid /data volume shadow)' 2>&1 | tail -3; "
    "git push --force https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git main 2>&1 | tail -5; "
    "cd /tmp && rm -rf kali-build run-*.sh patch-vol.py; "
    "echo 'STEP1_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
out = stdout.read().decode("utf-8", errors="replace")
print(out)
if "STEP1_DONE" not in out:
    print("[!] Failed", flush=True)
    client.close()
    sys.exit(1)
print("[+] Step 1 complete", flush=True)
client.close()

# Step 2: Wait for build
print("\n[2/4] Wait for build...", flush=True)
for attempt in range(1, 31):
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
                print(f"  [{attempt}/30] {s}/{c} (run #{run['run_number']})", flush=True)
                if s == "completed" and c == "success":
                    print("[+] BUILD SUCCEEDED!", flush=True)
                    break
                if s == "completed" and c == "failure":
                    print("[!] BUILD FAILED", flush=True)
                    sys.exit(1)
    except Exception as e:
        print(f"  [{attempt}/30] {type(e).__name__}", flush=True)
else:
    print("[!] Timeout", flush=True)
    sys.exit(1)

# Step 3: Deploy
print("\n[3/4] Deploy...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

cmd = (
    "docker rm -f kali rara 2>/dev/null; "
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
    "ghcr.io/yz776/kali-linux:main 2>&1 | tail -3; "
    "sleep 120; echo 'STEP3_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=240)
print(stdout.read().decode("utf-8", errors="replace"))
print("[+] Step 3 complete", flush=True)

# Step 4: Verify
print("\n[4/4] Verify...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== docker ps ==='; "
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -30; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3051|47291|8090)' | head -15; "
    "echo; echo '=== rara-web (3002) ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3; "
    "echo; echo '=== rara-agent at /opt ==='; "
    "docker exec kali ls /opt/rara-agent/.next/standalone/server.js 2>&1; "
    "echo; echo '=== rara-web PM2 logs (last 10) ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== rara-zrouter PM2 logs (last 10) ==='; "
    "docker exec kali pm2 logs rara-zrouter --lines 10 --nostream 2>&1 | tail -15",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

print("\n" + "=" * 70, flush=True)
print("  DEPLOY COMPLETE", flush=True)
print("=" * 70, flush=True)
