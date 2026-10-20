#!/usr/bin/env python3
"""Debug: check LoginScreen.tsx content + fix if broken."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Check the actual LoginScreen.tsx content in the container
print("=== LoginScreen.tsx content ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali cat /opt/rara-agent/src/components/LoginScreen.tsx 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check the auth route
print("\n=== auth/route.ts content ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali cat /opt/rara-agent/src/app/api/auth/route.ts 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check if the standalone build includes the changes
print("\n=== check standalone server.js for 'skip' ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali grep -c 'skip' /opt/rara-agent/.next/standalone/server.js 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check the api-client.ts login function
print("\n=== api-client.ts login function ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali grep -A15 'export async function login' /opt/rara-agent/src/lib/api-client.ts 2>&1 | head -20",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check rara-web logs
print("\n=== rara-web logs ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 logs rara-web --lines 15 --nostream 2>&1 | tail -20",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

client.close()
