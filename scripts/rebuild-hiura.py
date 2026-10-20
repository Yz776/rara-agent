#!/usr/bin/env python3
"""Fix: rebuild Next.js AFTER renaming hiura files so the build manifest picks them up."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Rebuild after file rename — the build will copy public/ to standalone/public/
print("=== Rebuild Next.js (after hiura rename) ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -10"
    "'",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart
print("\n=== Restart ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== Test hiura images ==='; "
    "for E in idle happy thinking talking shy surprised; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3002/hiura/$E.png 2>/dev/null); "
    "  echo \"  hiura/$E.png → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
