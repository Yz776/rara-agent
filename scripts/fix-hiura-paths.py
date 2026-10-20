#!/usr/bin/env python3
"""Fix: copy hiura images to standalone build's public dir."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# The standalone build copies public/ to .next/standalone/public/
# But it may not include subdirectories — let's copy manually
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "mkdir -p .next/standalone/public/hiura && "
    "cp -r public/hiura/* .next/standalone/public/hiura/ && "
    "ls -la .next/standalone/public/hiura/ && "
    "echo; echo \"=== test image ===\"; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3002/hiura/idle.png"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart rara-web to pick up new static files
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 5; "
    "echo; echo '=== test all images ==='; "
    "for E in idle happy thinking talking shy surprised; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:3002/hiura/$E.png 2>/dev/null); "
    "  echo \"  hiura/$E.png → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
