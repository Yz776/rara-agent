#!/usr/bin/env python3
"""Debug: check why Cloudflare returns 521 — test direct origin access."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    # Check ALL listening ports
    "echo '=== All listening ports ==='; "
    "ss -tlnp | head -20; "
    # Check if port 443 is listening (Cloudflare Full mode needs HTTPS)
    "echo; echo '=== port 443 ==='; "
    "ss -tlnp | grep ':443' | head -3; "
    # Check nginx config — does it listen on 443?
    "echo; echo '=== nginx listen directives ==='; "
    "docker exec kali grep -r 'listen' /etc/nginx/conf.d/ 2>&1 | head -10; "
    # Test HTTP (port 80) from server itself
    "echo; echo '=== HTTP port 80 tests (with Host header) ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" http://127.0.0.1:80/ 2>/dev/null); "
    "  echo \"  $D → HTTP $CODE\"; "
    "done; "
    # Test HTTPS (port 443) — Cloudflare Full mode needs this
    "echo; echo '=== HTTPS port 443 test ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org; do "
    "  CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" https://127.0.0.1:443/ 2>/dev/null); "
    "  echo \"  $D → HTTPS $CODE\"; "
    "done; "
    # Check if certbot/SSL certs exist
    "echo; echo '=== SSL certs ==='; "
    "docker exec kali ls /etc/letsencrypt/live/ 2>&1 | head -5; "
    "docker exec kali ls /etc/ssl/certs/*.pem 2>&1 | head -3; "
    # Check what Cloudflare sees — test from server to Cloudflare
    "echo; echo '=== Cloudflare edge test ==='; "
    "curl -sI --max-time 10 https://rara.ai.id/ 2>&1 | head -10; "
    "echo; curl -sI --max-time 10 https://storage.kangwifi.eu.org/ 2>&1 | head -5",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
