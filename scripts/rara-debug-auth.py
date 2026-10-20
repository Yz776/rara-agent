#!/usr/bin/env python3
"""Quick check on what's actually happening with port 3002."""

import os
import sys
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

if not PASS:
    sys.exit(2)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)


def run(cmd: str, timeout: int = 60) -> None:
    print(f"$ {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    if out.strip():
        print(out.rstrip()[:2000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:500]}")
    print()


# Direct curl without going through any shell-quoting complexity
run("docker exec kali curl -sS -X POST http://127.0.0.1:3002/api/auth -H 'Content-Type: application/json' -d '{}' --noproxy '*' --max-time 10")
run("docker exec kali curl -sS http://127.0.0.1:3002/ --noproxy '*' --max-time 10 -o /dev/null -w 'http=%{http_code} size=%{size_download}\\n'")
run("docker exec kali curl -sSv http://127.0.0.1:3002/api/auth -X POST -H 'Content-Type: application/json' -d '{}' --noproxy '*' --max-time 10 2>&1 | head -40")
# Check if any HTTP_PROXY env is set inside the container
run("docker exec kali env | grep -i proxy")
# Check pm2 + ports right now
run("docker exec kali pm2 list 2>&1 | grep -E 'rara|name|id '")
run("docker exec kali ss -tlnp 2>&1 | grep -E ':300[0-9]'")
# Tail the latest logs
run("docker exec kali tail -30 /opt/rara-agent/logs/rara-web-out.log 2>&1")
run("docker exec kali tail -30 /opt/rara-agent/logs/rara-web-err.log 2>&1")

# Hit /api/auth with explicit Host header that nginx might match
run("docker exec kali curl -sSv -X POST http://127.0.0.1:3002/api/auth -H 'Content-Type: application/json' -d '{}' --max-time 10 2>&1 | head -50")

client.close()
