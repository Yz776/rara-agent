#!/usr/bin/env python3
"""Fix: kill zombie rara-web + restart."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Kill anything on port 3002 + restart rara-web
stdin, stdout, stderr = client.exec_command(
    "echo '=== kill zombie on port 3002 ==='; "
    "docker exec kali bash -c 'fuser -k 3002/tcp 2>/dev/null || true'; "
    "sleep 2; "
    "echo; echo '=== restart rara-web ==='; "
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== rara-web logs ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(3001|3002)' | head -5; "
    "echo; echo '=== HTTP rara-web ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -5; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3; "
    "echo; echo '=== FINAL PM2 STATUS ==='; "
    "docker exec kali pm2 list 2>&1 | head -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
