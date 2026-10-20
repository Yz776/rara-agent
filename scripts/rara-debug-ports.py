#!/usr/bin/env python3
"""Investigate the port conflict on 3000 — find what catur is bound to."""

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
        print(f"[stderr] {err.rstrip()[:1000]}")
    print()


# What's the catur PM2 process running? Show its command + env.
run("docker exec kali sh -c 'pm2 show catur 2>&1 | head -40'")
# What's the catur source dir layout?
run("docker exec kali sh -c 'ls /opt 2>&1'")
# Check catur's startup files for port binding
run("docker exec kali sh -c 'find /opt -maxdepth 3 -name \"*.js\" -path \"*catur*\" 2>/dev/null | head -10'")
run("docker exec kali sh -c 'find /opt -maxdepth 3 -name \"*.env\" -o -name \".env\" 2>/dev/null | head -20'")
# Check what's bound to ports 3000-3010
run("docker exec kali sh -c 'ss -tlnp 2>&1 | grep -E \":300[0-9]\"'")
# Check nginx config to see what port each domain proxies to
run("docker exec kali sh -c 'cat /etc/nginx/sites-enabled/* 2>/dev/null | head -100'")
run("docker exec kali sh -c 'cat /etc/nginx/conf.d/*.conf 2>/dev/null | head -100'")

client.close()
