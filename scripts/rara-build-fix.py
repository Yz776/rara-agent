#!/usr/bin/env python3
"""Fix: stop non-essential apps, free memory, rebuild Next.js with NODE_OPTIONS."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

print("=== Step 1: Stop non-essential PM2 apps to free memory ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 stop animest catur cloudflared-ssh ttt nginx mysql 2>&1 | head -5; "
    "echo; echo '=== free memory after stop ==='; "
    "docker exec kali free -h | head -3; "
    "echo; echo '=== PM2 status (only essential running) ==='; "
    "docker exec kali pm2 list 2>&1 | head -15",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

print("\n=== Step 2: Build Next.js with higher memory limit ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -20"
    "'",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))

print("\n=== Step 3: Verify server.js exists ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali ls -la /opt/rara-agent/.next/standalone/server.js 2>&1; "
    "echo; echo '=== ls .next/standalone/ ==='; "
    "docker exec kali ls /opt/rara-agent/.next/standalone/ 2>&1 | head -10",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

print("\n=== Step 4: Restart all apps ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart all --update-env 2>&1 | head -5; "
    "sleep 20; "
    "echo; echo '=== PM2 status ==='; "
    "docker exec kali pm2 list 2>&1 | head -20; "
    "echo; echo '=== rara-web logs ==='; "
    "docker exec kali pm2 logs rara-web --lines 5 --nostream 2>&1 | tail -10; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(3001|3002)' | head -5; "
    "echo; echo '=== HTTP rara-web ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
