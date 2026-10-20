#!/usr/bin/env python3
"""Fix: remove default nginx site + start nginx."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    # Remove the default nginx site that conflicts
    "docker exec kali rm -f /etc/nginx/sites-enabled/default; "
    "docker exec kali rm -f /etc/nginx/sites-available/default; "
    # Test nginx config
    "echo '=== nginx config test ==='; "
    "docker exec kali nginx -t 2>&1; "
    # Start nginx
    "echo; echo '=== starting nginx ==='; "
    "docker exec kali nginx 2>&1; "
    "sleep 3; "
    # Verify port 80 is now listening
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(80|443|3002|3001|8090|47291)' | head -10; "
    # HTTP tests with Host headers
    "echo; echo '=== HTTP tests (via Host header) ==='; "
    "for DOMAIN_HOST in 'rara.ai.id' 'storage.kangwifi.eu.org' 'game.kangwifi.eu.org' 'wotanime.my.id'; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $DOMAIN_HOST\" http://localhost:80/ 2>/dev/null); "
    "  echo \"  $DOMAIN_HOST → HTTP $CODE\"; "
    "done; "
    # External tests via Cloudflare
    "echo; echo '=== External tests (via Cloudflare) ==='; "
    "for DOMAIN in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$DOMAIN/ 2>/dev/null); "
    "  echo \"  https://$DOMAIN → HTTP $CODE\"; "
    "done",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
