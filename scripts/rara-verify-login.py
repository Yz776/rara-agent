#!/usr/bin/env python3
"""Verify the new admin login + simplified /api/auth flow end-to-end."""

import os
import sys
import json
import time
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

if not PASS:
    sys.exit(2)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"


def run(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    print(f"$ {cmd[:200]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.rstrip()[:1500])
    if err.strip():
        print(f"[stderr] {err[:500]}")
    print()
    return code, out, err


# Write a small bash script that does the curl probes — avoids shell-quoting hell.
probe_script = r"""#!/bin/bash
set -e
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"

echo "─── 1. POST /api/auth (empty body, browser UA) ───"
RESP=$(curl -sS -X POST http://127.0.0.1:3002/api/auth \
    -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{}' \
    --max-time 10)
echo "$RESP"
TOKEN=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || echo "")
echo "TOKEN_LEN=${#TOKEN}"

echo ""
echo "─── 2. GET /api/auth (validate token works) ───"
curl -sS http://127.0.0.1:3002/api/auth \
    -H "Authorization: Bearer $TOKEN" \
    -H "User-Agent: $UA" \
    --max-time 10
echo ""

echo ""
echo "─── 3. POST /api/admin/login (wrong password → should 401) ───"
curl -sS -X POST http://127.0.0.1:3002/api/admin/login \
    -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{"username":"admin","password":"wrong-password"}' \
    --max-time 10
echo ""

echo ""
echo "─── 4. POST /api/admin/login (correct creds → should return adminKey) ───"
ADMIN_RESP=$(curl -sS -X POST http://127.0.0.1:3002/api/admin/login \
    -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{"username":"admin","password":"zHTQTNNh8sso9Fo/Pq+h1Xma"}' \
    --max-time 10)
echo "$ADMIN_RESP"
ADMIN_KEY=$(echo "$ADMIN_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("adminKey",""))' 2>/dev/null || echo "")
echo "ADMIN_KEY_LEN=${#ADMIN_KEY}"

echo ""
echo "─── 5. GET /api/admin/users (with admin key from login) ───"
curl -sS http://127.0.0.1:3002/api/admin/users \
    -H "User-Agent: $UA" \
    -H "X-Admin-Key: $ADMIN_KEY" \
    --max-time 10
echo ""

echo ""
echo "─── 6. GET /admin (HTML page — should show username/password form, not 'Admin Key' label) ───"
HTML=$(curl -sS http://127.0.0.1:3002/admin \
    -H "User-Agent: $UA" \
    --max-time 10)
# Check for the new Username field label + the absence of the old "Admin Key" label
if echo "$HTML" | grep -q "Username"; then
    echo "  ✓ /admin HTML contains 'Username' field label"
else
    echo "  ✗ /admin HTML does NOT contain 'Username' field label"
fi
if echo "$HTML" | grep -qE 'placeholder="64-char hex key"'; then
    echo "  ✗ /admin HTML still has old '64-char hex key' placeholder"
else
    echo "  ✓ old '64-char hex key' placeholder is gone"
fi
if echo "$HTML" | grep -q "Masuk Admin"; then
    echo "  ✓ 'Masuk Admin' button present"
fi

echo ""
echo "─── 7. External probe: https://rara.ai.id/ ───"
curl -sk -o /dev/null -w 'http=%{http_code} size=%{size_download}\n' \
    -H "User-Agent: $UA" \
    https://rara.ai.id/
"""

# Write the script to host /tmp then docker cp into container
tmp_path = "/home/z/my-project/scripts/probe-login.sh"
with open(tmp_path, "w", encoding="utf-8") as f:
    f.write(probe_script)

sftp = client.open_sftp()
sftp.put(tmp_path, "/tmp/probe-login.sh")
sftp.close()

# Make executable + docker cp + run inside container
run("docker cp /tmp/probe-login.sh kali:/tmp/probe-login.sh")
run("docker exec kali chmod +x /tmp/probe-login.sh")
run("docker exec kali bash /tmp/probe-login.sh", timeout=90)

# Show PM2 status
print("\n─── 8. PM2 status ───")
run("docker exec kali pm2 list 2>&1 | grep -E 'rara|name|id '")
run("docker exec kali ss -tlnp 2>&1 | grep -E ':300[0-9]'")

# Show recent pm2 logs to confirm no errors during the probes
print("\n─── 9. Recent pm2 logs rara-web ───")
run("docker exec kali pm2 logs rara-web --lines 15 --nostream 2>&1 | tail -25")

client.close()
print("\n✓ verification complete")
