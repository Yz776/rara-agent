#!/usr/bin/env python3
"""Check why rara-web isn't running in the new kali container."""

import os
import sys
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)


def run(cmd: str, timeout: int = 60) -> None:
    print(f"$ {cmd[:240]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    if out:
        print(out.rstrip()[:3000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:1500]}")
    print()


# Wait + check
print("─── 1. Wait 60s + recheck ───")
import time
time.sleep(60)

print("─── 2. PM2 list (full) ───")
run("docker exec kali pm2 list 2>&1")

print("─── 3. PM2 logs (last 50 lines) ───")
run("docker exec kali pm2 logs --lines 50 --nostream 2>&1 | tail -80")

print("─── 4. Check /opt/rara-agent on the new container ───")
run("docker exec kali ls -la /opt/rara-agent 2>&1 | head -20")
run("docker exec kali ls /opt/rara-agent/.next/standalone/server.js 2>&1")
run("docker exec kali cat /opt/rara-agent/.env 2>&1 | head -10")
run("docker exec kali ls -la /usr/local/bin/run-rara-web.sh 2>&1")
run("docker exec kali cat /usr/local/bin/run-rara-web.sh 2>&1 | head -30")

print("─── 5. PM2 ecosystem on kali ───")
run("docker exec kali cat /data/root/.pm2/dump.pm2 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(p[\"name\"], p.get(\"pm_exec_path\"),p.get(\"status\")) for p in d]' 2>&1 | head -20")
run("docker exec kali ls /usr/local/bin/start-all.sh 2>&1")
run("docker exec kali cat /usr/local/bin/start-all.sh 2>&1 | head -50")

client.close()
