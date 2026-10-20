#!/usr/bin/env python3
"""Check domains + install real nginx + configure reverse proxy."""
import paramiko, base64

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Check what domains resolve to this server + what nginx config existed
print("=== Check existing nginx config in old image ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    # Check if old image has nginx config we can reuse
    "echo '=== nginx config in :main image ==='; "
    "docker run --rm --entrypoint cat ghcr.io/yz776/kali-linux:main /etc/nginx/nginx.conf 2>&1 | head -30; "
    "echo; echo '=== nginx sites in :main ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main /etc/nginx/sites-enabled/ 2>&1 | head -10; "
    "echo; echo '=== nginx conf.d in :main ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main /etc/nginx/conf.d/ 2>&1 | head -10; "
    "echo; echo '=== run-nginx.sh from :latest (older but has real nginx) ==='; "
    "docker run --rm --entrypoint cat ghcr.io/yz776/kali-linux:latest /usr/local/bin/run-nginx.sh 2>&1 | head -30; "
    "echo; echo '=== check domains DNS ==='; "
    "for DOMAIN in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  IP=$(dig +short $DOMAIN 2>/dev/null | head -1); "
    "  echo \"  $DOMAIN → $IP\"; "
    "done; "
    "echo; echo '=== server public IP ==='; "
    "curl -s ifconfig.me 2>&1",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
