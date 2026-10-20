#!/usr/bin/env python3
"""
Complete restructure:
1. Stop + delete cloudflared-ssh + ttt from PM2
2. Start animest (install deps + restart)
3. Find catur port + configure nginx:
   - bot.kangwifi.eu.org → port 3000 (WhatsApp bot)
   - game.kangwifi.eu.org → catur port
   - wotanime.my.id → port 3051 (animest)
4. Reload nginx + test all domains
"""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Step 1: Stop + delete cloudflared-ssh + ttt
print("=== Step 1: Remove cloudflared-ssh + ttt from PM2 ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 stop cloudflared-ssh ttt 2>&1 | head -5; "
    "docker exec kali pm2 delete cloudflared-ssh ttt 2>&1 | head -5; "
    "echo; echo '=== PM2 after cleanup ==='; "
    "docker exec kali pm2 list 2>&1 | grep -v 'PM2+' | head -15",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 2: Check catur's run script + port
print("\n=== Step 2: Check catur run script + port ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== run-catur.sh ==='; "
    "docker exec kali cat /usr/local/bin/run-catur.sh 2>&1 | head -15; "
    "echo; echo '=== catur dir ==='; "
    "docker exec kali ls /data/apps/catur/ 2>&1 | head -10; "
    "echo; echo '=== catur .env ==='; "
    "docker exec kali cat /data/apps/catur/.env 2>&1 | head -10; "
    "echo; echo '=== catur package.json scripts ==='; "
    "docker exec kali bash -c 'cd /data/apps/catur && cat package.json 2>/dev/null | grep -A5 scripts' 2>&1 | head -10",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 3: Start animest (install deps)
print("\n=== Step 3: Install animest deps + restart ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== animest dir ==='; "
    "docker exec kali ls /data/apps/animest/ 2>&1 | head -10; "
    "echo; echo '=== install deps ==='; "
    "docker exec kali bash -c 'cd /data/apps/animest && /root/.bun/bin/bun install 2>&1 | tail -10'; "
    "echo; echo '=== check package.json for start script ==='; "
    "docker exec kali bash -c 'cd /data/apps/animest && cat package.json 2>/dev/null | grep -A5 scripts' 2>&1 | head -10; "
    "echo; echo '=== restart animest ==='; "
    "docker exec kali pm2 restart animest --update-env 2>&1 | head -3; "
    "sleep 15; "
    "echo; echo '=== animest status ==='; "
    "docker exec kali pm2 list 2>&1 | grep animest; "
    "echo; echo '=== animest logs ==='; "
    "docker exec kali pm2 logs animest --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== check port 3051 ==='; "
    "ss -tlnp | grep ':3051' | head -3",
    timeout=120
)
print(stdout.read().decode("utf-8", errors="replace"))

client.close()
