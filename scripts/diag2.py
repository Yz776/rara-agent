#!/usr/bin/env python3
"""Diagnose: check if Dockerfile changes made it into the image."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    "echo '=== check Dockerfile in latest image (grep for rara) ==='; "
    "docker run --rm --entrypoint grep ghcr.io/yz776/kali-linux:main -c 'rara' /usr/local/bin/start-all.sh 2>&1 | head -3; "
    "echo; echo '=== check run-rara scripts in image ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /usr/local/bin/run-*.sh 2>&1 | head -15; "
    "echo; echo '=== check /data/apps/rara-agent in image ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /data/apps/rara-agent/ 2>&1 | head -10; "
    "echo; echo '=== check what the Dockerfile looks like at HEAD ==='; "
    "docker run --rm --entrypoint grep ghcr.io/yz776/kali-linux:main 'Bundle rara-agent' /Dockerfile 2>&1 | head -3; "
    "echo; echo '=== rara-web PM2 error log ==='; "
    "docker exec kali pm2 logs rara-web --lines 15 --nostream 2>&1 | tail -20; "
    "echo; echo '=== rara-zrouter PM2 error log ==='; "
    "docker exec kali pm2 logs rara-zrouter --lines 15 --nostream 2>&1 | tail -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
