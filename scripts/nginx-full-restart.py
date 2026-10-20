#!/usr/bin/env python3
"""Full nginx restart + debug SSL."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    # Full restart nginx (stop all + start fresh)
    "echo '=== stop all nginx ==='; "
    "docker exec kali nginx -s stop 2>&1; sleep 2; "
    "docker exec kali pkill nginx 2>/dev/null; sleep 2; "
    "echo; echo '=== start nginx fresh ==='; "
    "docker exec kali nginx 2>&1; sleep 3; "
    # Verify
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(80|443)' | head -10; "
    # Verbose HTTPS test
    "echo; echo '=== verbose HTTPS test ==='; "
    "curl -vsk --max-time 5 -H 'Host: rara.ai.id' https://127.0.0.1:443/ 2>&1 | head -20; "
    # Quick external tests
    "echo; echo '=== external tests ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → $CODE\"; "
    "done",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err[:500])
client.close()
