#!/usr/bin/env python3
"""Debug: check if Cloudflare is caching old page + purge cache + test mobile rendering."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Check if Cloudflare is caching
print("=== Check Cloudflare cache headers ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== Response headers from rara.ai.id ==='; "
    "curl -sI https://rara.ai.id/ 2>&1 | head -15; "
    "echo; echo '=== Check hiura image via Cloudflare ==='; "
    "curl -sI https://rara.ai.id/hiura/idle.png 2>&1 | head -10; "
    "echo; echo '=== Check via localhost ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -10; "
    "echo; echo '=== rara-web logs (last 10) ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== Check page.tsx content in container ==='; "
    "docker exec kali cat /opt/rara-agent/src/app/page.tsx 2>&1 | head -20",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check if the welcome screen HTML is being served properly
print("\n=== Check HTML content ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "curl -s http://localhost:3002/ 2>&1 | grep -E 'belum ada|Rara|ceria|new chat|guest|welcome' | head -10",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

client.close()
