#!/usr/bin/env python3
"""Debug + fix SSL cert generation."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Check if openssl exists + try generating cert directly
print("=== Debug SSL cert ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== openssl in container ==='; "
    "docker exec kali which openssl 2>&1; "
    "echo; echo '=== generate cert (direct, no bash -c) ==='; "
    "docker exec kali mkdir -p /etc/nginx/ssl 2>&1; "
    "docker exec kali openssl req -x509 -nodes -days 3650 -newkey rsa:2048 "
    "-keyout /etc/nginx/ssl/selfsigned.key "
    "-out /etc/nginx/ssl/selfsigned.crt "
    "-subj '/CN=*.ai.id/O=Rara/C=ID' 2>&1; "
    "echo; echo '=== verify cert exists ==='; "
    "docker exec kali ls -la /etc/nginx/ssl/ 2>&1; "
    "echo; echo '=== test nginx config ==='; "
    "docker exec kali nginx -t 2>&1; "
    "echo; echo '=== reload nginx ==='; "
    "docker exec kali nginx -s reload 2>&1; "
    "sleep 3; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(80|443)' | head -5; "
    "echo; echo '=== HTTPS tests ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org; do "
    "  CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" https://127.0.0.1:443/ 2>/dev/null); "
    "  echo \"  $D HTTPS → $CODE\"; "
    "done; "
    "echo; echo '=== External tests ==='; "
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
