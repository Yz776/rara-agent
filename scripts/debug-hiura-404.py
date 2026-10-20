#!/usr/bin/env python3
"""Fix: debug why hiura images return 404 — check how standalone server serves static files."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "echo \"=== .next/standalone structure ===\"; "
    "ls -la /opt/rara-agent/.next/standalone/ | head -10; "
    "echo; echo \"=== .next/standalone/public ===\"; "
    "ls -la /opt/rara-agent/.next/standalone/public/ 2>&1 | head -10; "
    "echo; echo \"=== .next/standalone/public/hiura ===\"; "
    "ls -la /opt/rara-agent/.next/standalone/public/hiura/ 2>&1 | head -10; "
    "echo; echo \"=== .next/static dir ===\"; "
    "ls /opt/rara-agent/.next/static/ 2>&1 | head -5; "
    "echo; echo \"=== run-rara-web.sh — check cwd ===\"; "
    "cat /usr/local/bin/run-rara-web.sh 2>&1 | head -10; "
    "echo; echo \"=== test root images ===\"; "
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/logo.svg 2>&1; "
    "echo; echo \"=== test favicon ===\"; "
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/favicon.svg 2>&1"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
