#!/usr/bin/env python3
"""Fix: add nginx to PM2 (auto-restart) + start animest."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Step 1: Stop manually-started nginx + add to PM2 as real process
print("=== Step 1: Add nginx to PM2 (auto-restart) ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali nginx -s stop 2>&1; sleep 2; "
    "docker exec kali pm2 start nginx --name nginx --interpreter bash -- -g 'daemon off;' 2>&1 | head -5; "
    "sleep 3; "
    "echo; echo '=== PM2 nginx status ==='; "
    "docker exec kali pm2 list 2>&1 | grep -E 'nginx|rara|cloud|aiodl|ttt'; "
    "echo; echo '=== port 80 ==='; "
    "ss -tlnp | grep ':80' | head -3",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 2: Save PM2 config so it survives restarts
print("\n=== Step 2: Save PM2 config ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 save 2>&1 | head -3; "
    "echo; echo '=== PM2 saved ==='",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 3: Final domain tests
print("\n=== Step 3: Final domain tests ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== Local (via Host header) ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" http://localhost:80/ 2>/dev/null); "
    "  echo \"  $D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== External (via Cloudflare HTTPS) ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== PM2 final status ==='; "
    "docker exec kali pm2 list 2>&1 | head -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
