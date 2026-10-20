#!/usr/bin/env python3
"""Fix: check verifyToken + conversations API + get admin key."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# 1. Check if verifyToken fix survived the rebuild
print("=== 1. Check verifyToken fix ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali grep -n 'SKIP\\|disabled\\|false &&' /opt/rara-agent/src/lib/auth.ts 2>&1 | head -5; "
    "echo; echo '=== check compiled server.js ==='; "
    "docker exec kali grep -c 'SKIP\\|disabled' /opt/rara-agent/.next/standalone/server.js 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# 2. Test conversations API
print("\n=== 2. Test conversations API ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "TOKEN=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo \"Token: ${TOKEN:0:10}...\"; "
    "echo; echo 'GET /api/conversations:'; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations --max-time 10 2>&1 | head -c 300; "
    "echo; echo; echo 'GET /api/auth (verify token works?):'; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 200",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# 3. Get admin keys
print("\n=== 3. Admin Panel Keys ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== KROUTER_INTERNAL_TOKEN ==='; "
    "docker exec kali bash -c 'pm2 env 8 2>&1 | grep KROUTER_INTERNAL_TOKEN'; "
    "echo; echo '=== KROUTER_ADMIN_PASSWORD ==='; "
    "docker exec kali bash -c 'pm2 env 8 2>&1 | grep KROUTER_ADMIN_PASSWORD'; "
    "echo; echo '=== KROUTER_ADMIN_USERNAME ==='; "
    "docker exec kali bash -c 'pm2 env 8 2>&1 | grep KROUTER_ADMIN_USERNAME'; "
    "echo; echo '=== KFAI_AUTH_SECRET ==='; "
    "docker exec kali bash -c 'pm2 env 7 2>&1 | grep KFAI_AUTH_SECRET'; "
    "echo; echo '=== zrouter admin panel URL ==='; "
    "echo 'Internal: http://127.0.0.1:3001 (accessible via docker exec only)'; "
    "echo 'External: NOT exposed (locked down to localhost)'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# 4. Check what error occurs when loading conversations
print("\n=== 4. Check conversation loading ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "TOKEN=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo '=== Create a conversation ==='; "
    "curl -s -X POST http://localhost:3002/api/conversations -H 'Content-Type: application/json' -H \"Authorization: Bearer $TOKEN\" -d '{\"title\":\"test\"}' --max-time 10 2>&1 | head -c 300; "
    "echo; echo; echo '=== List conversations ==='; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations --max-time 10 2>&1 | head -c 300; "
    "echo; echo; echo '=== Get conversation by ID ==='; "
    "CONV_ID=$(curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations --max-time 10 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[\"conversations\"][0][\"id\"] if d.get(\"conversations\") else \"none\")' 2>/dev/null); "
    "echo \"Conv ID: $CONV_ID\"; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations/$CONV_ID --max-time 10 2>&1 | head -c 300",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# 5. Check rara-web logs for errors
print("\n=== 5. rara-web logs ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 logs rara-web --lines 20 --nostream 2>&1 | tail -25",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

client.close()
