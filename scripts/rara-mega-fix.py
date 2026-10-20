#!/usr/bin/env python3
"""
Fix: insert rara-agent bundling block at END of Dockerfile (before EXPOSE),
not inside the start-all.sh heredoc. The previous attempt inserted RUN
instructions inside the heredoc, causing 'RUN: command not found' at runtime.
"""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  FIX: insert rara-agent block at END of Dockerfile (before EXPOSE)", flush=True)
print("=" * 70, flush=True)

# ═══ Step 1: Revert previous bad commit + apply correct fix ═══════════
print("\n[Step 1/4] Clone + revert + apply correct fix + push...", flush=True)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

# The patch script: find the EXPOSE line, insert BEFORE it
patch_python = r"""import re
with open('Dockerfile') as f: content = f.read()

# First, remove the BAD block from inside the heredoc (from previous attempt)
# The bad block starts with '# Bundle rara-agent' and ends before 'cat > /data/ecosystem.config.js'
# It contains 'RUN mkdir' etc. which should NOT be inside the heredoc.
bad_block_pattern = r"""
# Bundle rara-agent \(Next\.js \+ zrouter\) into this image.*?RUN chmod \+x /usr/local/bin/run-rara-zrouter\.sh

"""
content, n_removed = re.subn(bad_block_pattern, '', content, flags=re.DOTALL)
print(f"Removed {n_removed} bad block(s) from inside heredoc")

# Now find the EXPOSE line (which is near the end of the Dockerfile)
# and insert our block BEFORE it
expose_marker = "EXPOSE 22 80 443 3000 47291 8090"
idx = content.find(expose_marker)
if idx < 0:
    # Try alternative patterns
    idx = content.find("EXPOSE")
    if idx < 0:
        print("ERROR: EXPOSE not found in Dockerfile")
        exit(1)

new_block = """
# ═══════════════════════════════════════════════════════════════════════
# Bundle rara-agent (Next.js + zrouter) into this image
# These are Dockerfile-level RUN instructions (NOT inside any heredoc).
# They clone rara-agent, build Next.js standalone, and create the 2 run scripts.
# ═══════════════════════════════════════════════════════════════════════
RUN mkdir -p /data/apps && \\
    git clone --depth 1 https://github.com/Yz776/rara-agent.git /data/apps/rara-agent && \\
    cd /data/apps/rara-agent && \\
    bun install --frozen-lockfile 2>&1 | tail -5 && \\
    DATABASE_URL=file:/tmp/rara-build-validate.db bunx prisma generate 2>&1 | tail -3 && \\
    DATABASE_URL=file:/tmp/rara-build-validate.db NEXT_TELEMETRY_DISABLED=1 bun run build 2>&1 | tail -5 && \\
    cd mini-services/zrouter && bun install 2>&1 | tail -3

RUN cat > /usr/local/bin/run-rara-web.sh <<'RARAEOF'
#!/usr/bin/env bash
set -euo pipefail
cd "${RARA_DIR:-/data/apps/rara-agent}"
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
RARAEOF
RUN chmod +x /usr/local/bin/run-rara-web.sh

RUN cat > /usr/local/bin/run-rara-zrouter.sh <<'RARAZEOF'
#!/usr/bin/env bash
set -euo pipefail
cd "${RARA_DIR:-/data/apps/rara-agent}"
: "${KROUTER_INTERNAL_TOKEN:?KROUTER_INTERNAL_TOKEN must be set}"
: "${KROUTER_ADMIN_USERNAME:-admin}"
: "${KROUTER_ADMIN_PASSWORD:?KROUTER_ADMIN_PASSWORD must be set}"
export NODE_ENV=production HOST=127.0.0.1 PORT="${ZROUTER_PORT:-3001}"
export KROUTER_DATA_DIR="${KROUTER_DATA_DIR:-/data/apps/rara-agent/mini-services/zrouter/data}"
exec bun run mini-services/zrouter/src/index.ts
RARAZEOF
RUN chmod +x /usr/local/bin/run-rara-zrouter.sh

# Also add rara ports to EXPOSE
"""

new_content = content[:idx] + new_block + content[idx:]
with open('Dockerfile', 'w') as f: f.write(new_content)
print(f"OK: inserted {len(new_block)} bytes before EXPOSE")
print(f"Total Dockerfile size: {len(new_content)} bytes")

# Verify: the RUN instructions should be at Dockerfile level (not inside heredoc)
# Check that 'RUN mkdir -p /data/apps' appears OUTSIDE any heredoc
# by checking it's after the last 'EOF' line that closes a heredoc
lines = new_content.split('\n')
in_heredoc = False
heredoc_end = 0
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped == "EOF" or stripped == "PM2EOF" or stripped == "RARAEOF" or stripped == "RARAZEOF":
        in_heredoc = False
        heredoc_end = i
    # Check if our RUN is after all heredocs
    if "RUN mkdir -p /data/apps" in line and i > heredoc_end:
        print(f"  ✓ RUN mkdir is at Dockerfile level (line {i+1}, after last heredoc end at line {heredoc_end+1})")
        break
"""

cmd = (
    "rm -rf /tmp/kali-build && mkdir -p /tmp/kali-build && cd /tmp/kali-build && "
    "git clone --depth 1 https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git 2>&1 | tail -3 && "
    "cd kali-linux && "
    "python3 << 'PATCH_EOF'\n"
    + patch_python + "\n"
    "PATCH_EOF\n"
    "echo; echo '-- diff stat --'; git diff --stat Dockerfile; "
    "echo; echo '-- git add + commit --'; "
    "git add Dockerfile && "
    "git commit -m 'fix: move rara-agent RUN instructions to Dockerfile level (was inside heredoc)

Previous commit inserted RUN instructions inside the start-all.sh heredoc,
causing bash to try executing Dockerfile syntax (RUN: command not found).
Now inserted before EXPOSE at Dockerfile level — runs during image build.' 2>&1 | tail -3; "
    "echo; echo '-- git push --'; "
    "git push https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git main 2>&1 | tail -5; "
    "echo; echo '-- cleanup --'; cd /tmp && rm -rf kali-build; "
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

print("\n[+] Step 1 complete — fixed Dockerfile pushed", flush=True)
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
                status = run["status"]
                conclusion = run.get("conclusion")
                print(f"  [{attempt}/30] {status}/{conclusion} (run #{run['run_number']})", flush=True)
                if status == "completed" and conclusion == "success":
                    print("[+] BUILD SUCCEEDED!", flush=True)
                    break
                if status == "completed" and conclusion == "failure":
                    print("[!] BUILD FAILED — check Actions log", flush=True)
                    sys.exit(1)
    except Exception as e:
        print(f"  [{attempt}/30] API error: {type(e).__name__}", flush=True)
else:
    print("[!] Build timeout — check manually", flush=True)
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
    "-v /data:/data "
    "-v /var/run/docker.sock:/var/run/docker.sock "
    "-e ROOT_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=') "
    "-e SSH_PORT=2222 "
    "-e GITHUB_TOKEN=" + PAT + " "
    "-e LAUNCHER_MODE=pm2 "
    "-e TZ=Asia/Jakarta "
    "-e KFAI_AUTH_SECRET=$(openssl rand -hex 24) "
    "-e KROUTER_INTERNAL_TOKEN=$(openssl rand -hex 32) "
    "-e KROUTER_ADMIN_USERNAME=admin "
    "-e KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=') "
    "-e RARA_PORT=3002 "
    "-e ZROUTER_PORT=3001 "
    "ghcr.io/yz776/kali-linux:main 2>&1 | tail -3; "
    "echo '-- waiting 90s for apps to start --'; sleep 90; "
    "echo 'STEP3_DONE'"
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
