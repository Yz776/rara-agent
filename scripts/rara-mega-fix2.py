#!/usr/bin/env python3
"""
Fix: write the Dockerfile patch as a SEPARATE file on the server via SFTP,
then execute it. Avoids all Python string escaping issues.
"""
import paramiko, base64, time, sys, json, urllib.request, io

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  FIX: correct Dockerfile + rebuild + deploy", flush=True)
print("=" * 70, flush=True)

# The Dockerfile patch script that runs on the server.
# Written as a plain text file (no Python string escaping issues).
PATCH_SCRIPT = """import re, sys

with open('Dockerfile') as f:
    content = f.read()

# Step A: Remove the BAD block from previous attempt (inside the heredoc).
# The bad block starts with '# Bundle rara-agent' and contains RUN instructions
# that were accidentally placed inside the start-all.sh heredoc.
bad_pattern = r'\\n# Bundle rara-agent \\(Next\\.js \\+ zrouter\\) into this image.*?RUN chmod \\+x /usr/local/bin/run-rara-zrouter\\.sh\\n'
content, n = re.subn(bad_pattern, '', content, flags=re.DOTALL)
print(f'Removed {n} bad block(s) from inside heredoc')

# Step B: Find the EXPOSE line and insert our block BEFORE it.
# This places the RUN instructions at Dockerfile level (outside any heredoc).
expose_idx = content.find('EXPOSE 22 80 443')
if expose_idx < 0:
    expose_idx = content.find('EXPOSE')
if expose_idx < 0:
    print('ERROR: EXPOSE not found')
    sys.exit(1)

new_block = '''
# Bundle rara-agent (Next.js + zrouter) into this image - Dockerfile level
RUN mkdir -p /data/apps && \\\\
    git clone --depth 1 https://github.com/Yz776/rara-agent.git /data/apps/rara-agent && \\\\
    cd /data/apps/rara-agent && \\\\
    bun install --frozen-lockfile 2>&1 | tail -5 && \\\\
    DATABASE_URL=file:/tmp/rara-build-validate.db bunx prisma generate 2>&1 | tail -3 && \\\\
    DATABASE_URL=file:/tmp/rara-build-validate.db NEXT_TELEMETRY_DISABLED=1 bun run build 2>&1 | tail -5 && \\\\
    cd mini-services/zrouter && bun install 2>&1 | tail -3

RUN printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cd "${RARA_DIR:-/data/apps/rara-agent}"' ': "${KFAI_AUTH_SECRET:?KFAI_AUTH_SECRET must be set}"' ': "${KROUTER_INTERNAL_TOKEN:?KROUTER_INTERNAL_TOKEN must be set}"' ': "${KROUTER_ADMIN_PASSWORD:?KROUTER_ADMIN_PASSWORD must be set}"' 'export NODE_ENV=production HOST=0.0.0.0 PORT="${RARA_PORT:-3002}"' 'export DATABASE_URL="${DATABASE_URL:-file:/data/apps/rara-agent/db/rara.db}"' 'export KROUTER_BASE="${KROUTER_BASE:-http://127.0.0.1:3001}"' 'export MCP_ENDPOINT="${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp}"' 'export RARA_BASE_URL="${RARA_BASE_URL:-http://127.0.0.1:3002}"' 'bun run db:push --accept-data-loss 2>/dev/null || true' 'exec bun .next/standalone/server.js' > /usr/local/bin/run-rara-web.sh && chmod +x /usr/local/bin/run-rara-web.sh

RUN printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'cd "${RARA_DIR:-/data/apps/rara-agent}"' ': "${KROUTER_INTERNAL_TOKEN:?KROUTER_INTERNAL_TOKEN must be set}"' ': "${KROUTER_ADMIN_USERNAME:-admin}"' ': "${KROUTER_ADMIN_PASSWORD:?KROUTER_ADMIN_PASSWORD must be set}"' 'export NODE_ENV=production HOST=127.0.0.1 PORT="${ZROUTER_PORT:-3001}"' 'export KROUTER_DATA_DIR="${KROUTER_DATA_DIR:-/data/apps/rara-agent/mini-services/zrouter/data}"' 'exec bun run mini-services/zrouter/src/index.ts' > /usr/local/bin/run-rara-zrouter.sh && chmod +x /usr/local/bin/run-rara-zrouter.sh

'''

new_content = content[:expose_idx] + new_block + content[expose_idx:]
with open('Dockerfile', 'w') as f:
    f.write(new_content)
print(f'OK: inserted {len(new_block)} bytes before EXPOSE')
print(f'Total Dockerfile: {len(new_content)} bytes')
"""

print("\n[Step 1/4] SFTP patch script to server + clone + apply + push...", flush=True)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

# Write the patch script to server via SFTP
sftp = client.open_sftp()
with sftp.file('/tmp/patch-dockerfile.py', 'w') as f:
    f.write(PATCH_SCRIPT)
print("  Patch script uploaded to /tmp/patch-dockerfile.py", flush=True)
sftp.close()

# Now run: clone repo + apply patch + commit + push
cmd = (
    "rm -rf /tmp/kali-build && mkdir -p /tmp/kali-build && cd /tmp/kali-build && "
    "git clone --depth 1 https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git 2>&1 | tail -3 && "
    "cd kali-linux && "
    "python3 /tmp/patch-dockerfile.py && "
    "echo; echo '-- diff stat --'; git diff --stat Dockerfile; "
    "echo; git add Dockerfile && "
    "git commit -m 'fix: move rara-agent RUN to Dockerfile level (was inside heredoc)' 2>&1 | tail -3; "
    "echo; git push https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git main 2>&1 | tail -5; "
    "echo; cd /tmp && rm -rf kali-build patch-dockerfile.py; "
    "echo 'STEP1_DONE'"
)

stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
print(out)
if err: print("STDERR:", err[-500:])

if "STEP1_DONE" not in out:
    print("\n[!] Step 1 may have failed", flush=True)
    client.close()
    sys.exit(1)

print("\n[+] Step 1 complete", flush=True)
client.close()

# ═══ Step 2: Wait for GH Actions build ═══════════════════════════════
print("\n[Step 2/4] Wait for GitHub Actions build...", flush=True)

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
                s = run["status"]
                c = run.get("conclusion")
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
    print("[!] Build timeout", flush=True)
    sys.exit(1)

# ═══ Step 3: Deploy ═════════════════════════════════════════════════
print("\n[Step 3/4] Deploy single container...", flush=True)

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
    "echo '-- waiting 90s --'; sleep 90; echo 'STEP3_DONE'"
)

stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
print("\n[+] Step 3 complete", flush=True)

# ═══ Step 4: Verify ═════════════════════════════════════════════════
print("\n[Step 4/4] Verify all features...", flush=True)

stdin, stdout, stderr = client.exec_command(
    "echo '=== docker ps ==='; "
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -25; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3051|47291|8090)' | head -15; "
    "echo; echo '=== rara-web (3002) ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))

client.close()
print("\n" + "=" * 70, flush=True)
print("  DEPLOY COMPLETE", flush=True)
print("=" * 70, flush=True)
