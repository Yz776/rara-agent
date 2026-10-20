#!/usr/bin/env python3
"""Fix: start nginx directly (not via PM2 bash interpreter)."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Delete errored nginx PM2 app + start nginx directly
print("=== Fix nginx ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 delete nginx 2>&1 | head -3; "
    # Start nginx directly (it daemonizes by default)
    "docker exec kali nginx 2>&1; "
    "sleep 3; "
    # Verify port 80
    "echo; echo '=== port 80 ==='; "
    "ss -tlnp | grep ':80' | head -3; "
    # Add nginx to PM2 properly (start as binary, not via bash)
    "echo; echo '=== add nginx to PM2 (no bash interpreter) ==='; "
    "docker exec kali pm2 start nginx --name nginx -- -g 'daemon off;' 2>&1 | head -5; "
    "sleep 3; "
    "echo; echo '=== PM2 nginx status ==='; "
    "docker exec kali pm2 list 2>&1 | grep nginx; "
    "echo; echo '=== port 80 after PM2 ==='; "
    "ss -tlnp | grep ':80' | head -3; "
    # Save PM2
    "echo; echo '=== save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -3; "
    # Final domain tests
    "echo; echo '=== Local domain tests ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" http://localhost:80/ 2>/dev/null); "
    "  echo \"  $D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== External domain tests ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → HTTP $CODE\"; "
    "done",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
