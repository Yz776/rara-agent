#!/usr/bin/env python3
"""Pull latest rara-agent source inside the kali container + rebuild + restart PM2."""

import os
import sys
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)


def run(cmd: str, timeout: int = 600) -> tuple[int, str, str]:
    print(f"$ {cmd[:240]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.rstrip()[:2500])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:800]}")
    if code != 0:
        print(f"[exit={code}]")
    return code, out, err


# 1. git pull inside the container
print("─── 1. git pull on /opt/rara-agent ───")
run("docker exec kali sh -c 'cd /opt/rara-agent && git fetch origin && git reset --hard origin/main && git log --oneline -3'", timeout=60)

# 2. bun install (in case deps changed)
print("\n─── 2. bun install ───")
run("docker exec kali sh -c 'cd /opt/rara-agent && bun install --frozen-lockfile 2>&1 | tail -5'", timeout=180)

# 3. Rebuild Next.js (with NODE_OPTIONS to avoid OOM)
print("\n─── 3. bun run build (with max-old-space-size=2048) ───")
code, out, _ = run("docker exec kali sh -c 'cd /opt/rara-agent && DATABASE_URL=file:/tmp/rara-build.db NODE_OPTIONS=--max-old-space-size=2048 bun run build 2>&1 | tail -20'", timeout=300)
if code != 0 or "error" in out.lower():
    print("✗ build failed")
    sys.exit(2)
print("✓ build OK")

# 4. Restart rara-web PM2 process (with .env sourced to pick up secrets)
print("\n─── 4. Restart rara-web PM2 ───")
run("docker exec kali pm2 delete rara-web 2>&1 || true")
run("docker exec kali bash -c 'cd /opt/rara-agent && set -a && . ./.env && set +a && pm2 start /usr/local/bin/run-rara-web.sh --name rara-web --interpreter bash' 2>&1 | tail -5")
run("docker exec kali pm2 save 2>&1 | tail -3")

# 5. Wait + verify
print("\n─── 5. Wait 15s + verify ───")
import time
time.sleep(15)

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
print("\n─── 6. /api/auth ───")
import re
code, out, _ = run(f"curl -sk -X POST -H 'Content-Type: application/json' -H 'User-Agent: {UA}' -d '{{}}' --max-time 10 https://rara.ai.id/api/auth")
m = re.search(r'"token":"([^"]+)"', out)
TOKEN = m.group(1) if m else ""
print(f"  TOKEN={TOKEN[:30]}...")

print("\n─── 7. /api/chat (SSE stream — capture first 2000 chars) ───")
run(f"curl -sk -N -X POST -H 'Content-Type: application/json' -H 'User-Agent: {UA}' -H 'Authorization: Bearer {TOKEN}' -d '{{\"message\":\"halo rara, kamu siapa?\"}}' --max-time 60 https://rara.ai.id/api/chat 2>&1 | head -c 2500")

print("\n─── 8. PM2 status ───")
run("docker exec kali pm2 list 2>&1 | grep -E 'rara|nginx|name|id '")

client.close()
print("\n✓ deploy complete")
