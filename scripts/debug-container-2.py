#!/usr/bin/env python3
"""Check /opt/rara-agent state inside the new container + restore .env."""

import os
import sys
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)


def run(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    print(f"$ {cmd[:240]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.rstrip()[:3000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:1000]}")
    if code != 0:
        print(f"[exit={code}]")
    print()
    return code, out, err


# 1. Check the actual layout inside /opt/rara-agent
print("─── 1. /opt/rara-agent layout ───")
run("docker exec kali ls -la /opt/rara-agent/ 2>&1 | head -25")
run("docker exec kali ls -la /opt/rara-agent/.next/ 2>&1 | head -10")
run("docker exec kali ls -la /opt/rara-agent/.next/standalone/ 2>&1 | head -10")

# 2. Check if .env exists anywhere
print("─── 2. Search for .env files ───")
run("docker exec kali find / -name '.env' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -10")

# 3. Check git state on the cloned rara-agent
print("─── 3. rara-agent git state inside container ───")
run("docker exec kali sh -c 'cd /opt/rara-agent && git log --oneline -3 2>&1'")
run("docker exec kali sh -c 'cd /opt/rara-agent && git status -s 2>&1 | head -5'")

# 4. Check rara-web PM2 logs
print("─── 4. PM2 logs rara-web (last 30 lines) ───")
run("docker exec kali pm2 logs rara-web --lines 30 --nostream 2>&1 | tail -40")

# 5. Check ports
print("─── 5. Listening ports ───")
run("docker exec kali ss -tlnp 2>&1 | head -20")

client.close()
