#!/usr/bin/env python3
"""Fix: standalone server.js uses CWD for public files, not .next/standalone/. 
The run script does 'cd /opt/rara-agent' — but standalone server.js is at 
.next/standalone/server.js. The server looks for public/ relative to CWD 
(= /opt/rara-agent/public/), NOT relative to server.js location.
So the images ARE at /opt/rara-agent/public/hiura/ — they should work.
Let me test with curl using the right path."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# The server.js is at .next/standalone/server.js but CWD is /opt/rara-agent
# Next.js standalone serves from CWD/public/ 
# Images ARE at /opt/rara-agent/public/hiura/
# But the filenames are hiura-IDLE.png (with dash) — the Rara3D.tsx uses /hiura/idle.png (no dash)
# THAT'S the bug! Filename mismatch!

print("=== Filename check ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali ls /opt/rara-agent/public/hiura/ 2>&1; "
    "echo; echo '=== Rara3D.tsx path references ==='; "
    "docker exec kali grep 'hiura' /opt/rara-agent/src/components/Rara3D.tsx 2>&1 | head -10",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Fix: rename files from hiura-IDLE.png to idle.png (no prefix)
print("\n=== Fix: rename files ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent/public/hiura && "
    "for f in hiura-*.png; do "
    "  new=$(echo $f | sed \"s/hiura-//\"); "
    "  mv \"$f\" \"$new\"; "
    "  echo \"renamed: $f → $new\"; "
    "done && "
    "ls -la"
    "'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Also fix in standalone dir
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent/.next/standalone/public/hiura && "
    "for f in hiura-*.png; do "
    "  new=$(echo $f | sed \"s/hiura-//\"); "
    "  mv \"$f\" \"$new\"; "
    "done && ls -la"
    "'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Test
print("\n=== Test images ===", flush=True)
stdin, stdout, stderr = client.exec_command(
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
