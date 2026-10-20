#!/usr/bin/env python3
"""Check the rara-web PM2 logs in detail + check what env vars are set."""

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
        print(out.rstrip()[:3000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:3000]}")
    print()


# 1. Read the full err log
run("docker exec kali sh -c 'cat /opt/rara-agent/logs/rara-web-err.log 2>&1 | tail -60'")
# 2. Read the out log
run("docker exec kali sh -c 'cat /opt/rara-agent/logs/rara-web-out.log 2>&1 | tail -40'")
# 3. Check the .env file on the server
run("docker exec kali sh -c 'cat /opt/rara-agent/.env 2>&1'")
# 4. Check ecosystem.config.cjs as deployed
run("docker exec kali sh -c 'cat /opt/rara-agent/ecosystem.config.cjs 2>&1 | head -60'")
# 5. Try to run server.js directly to see the actual error
run("docker exec kali sh -c 'cd /opt/rara-agent && timeout 8 node .next/standalone/server.js 2>&1 | head -40'")
# 6. Check listening ports
run("docker exec kali sh -c 'ss -tlnp 2>&1 | grep -E \":3000|:3001\" || netstat -tlnp 2>&1 | grep -E \":3000|:3001\"' 2>&1 || true")
# 7. Check what's responding on port 3000 (the mysterious 5327 byte response)
run("docker exec kali sh -c 'curl -s http://127.0.0.1:3000/ | head -c 500'")

client.close()
