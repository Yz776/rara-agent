#!/usr/bin/env python3
"""Debug: try running rara-web on port 3003 directly (not via PM2)."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Check what env vars PM2 passes to rara-web
print("=== Check PM2 env for rara-web ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'pm2 env 7 2>&1 | head -30'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Try running directly on port 3003
print("\n=== Try running server.js directly on port 3003 ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_ENV=production HOST=0.0.0.0 PORT=3003 "
    "DATABASE_URL=file:/data/apps/rara-agent/db/rara.db "
    "KROUTER_BASE=http://127.0.0.1:3001 "
    "MCP_ENDPOINT=http://127.0.0.1:3001/mcp "
    "RARA_BASE_URL=http://127.0.0.1:3003 "
    "KFAI_AUTH_SECRET=test "
    "KROUTER_INTERNAL_TOKEN=test "
    "KROUTER_ADMIN_PASSWORD=test && "
    "timeout 10 /root/.bun/bin/bun .next/standalone/server.js 2>&1 | head -15"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check if port 3003 is now listening
print("\n=== Check ports after direct run ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "ss -tlnp | grep -E ':(3001|3002|3003)' | head -5",
    timeout=10
)
print(stdout.read().decode("utf-8", errors="replace"))

# If direct run worked, update RARA_PORT to 3003 + restart via PM2
print("\n=== If direct worked, switch to port 3003 + restart PM2 ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    # Update run-rara-web.sh to use PORT=3003
    "docker exec kali sed -i 's|RARA_PORT:-3002|RARA_PORT:-3003|' /usr/local/bin/run-rara-web.sh; "
    "docker exec kali sed -i 's|RARA_BASE_URL:-http://127.0.0.1:3002|RARA_BASE_URL:-http://127.0.0.1:3003|' /usr/local/bin/run-rara-web.sh; "
    "echo '=== updated script ==='; "
    "docker exec kali grep -E 'PORT|BASE_URL' /usr/local/bin/run-rara-web.sh 2>&1; "
    "echo; echo '=== restart rara-web ==='; "
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== rara-web logs ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(3001|3002|3003)' | head -5; "
    "echo; echo '=== HTTP test ==='; "
    "curl -sI http://localhost:3003/ 2>&1 | head -5; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3; "
    "echo; echo '=== FINAL PM2 STATUS ==='; "
    "docker exec kali pm2 list 2>&1 | head -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
