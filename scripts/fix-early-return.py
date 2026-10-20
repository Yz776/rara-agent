#!/usr/bin/env python3
"""Fix: insert early return in verifyToken right after session validation."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

# Minimal fix: read original auth.ts from GitHub, insert early return after
# session.expiresAt check, before IP/fingerprint checks
FIX = r'''
with open("/tmp/original-auth.ts") as f:
    content = f.read()

# Find the line "if (session.expiresAt.getTime() < Date.now()) return null;"
# and insert an early return right after it
marker = "if (session.expiresAt.getTime() < Date.now()) return null;"
idx = content.find(marker)

if idx < 0:
    # Try alternative pattern
    marker = "session.expiresAt"
    idx = content.find(marker)
    if idx >= 0:
        # Find the end of that line
        line_end = content.find("\n", idx)
        marker = content[idx:line_end+1]
        print(f"Found expiresAt line: {marker.strip()}")

if idx >= 0:
    # Find the end of the marker line
    line_end = content.find("\n", idx) + 1
    
    # Insert early return right after the expiresAt check
    # This skips ALL IP + fingerprint checks
    early_return = """
  // ── SKIP ALL IP + FINGERPRINT CHECKS (keyless access) ──────────────
  // Return immediately after basic session validation
  return {
    userId: session.userId,
    token: session.token,
    sessionId: session.id,
    user: session.user,
    authId: session.user.authId,
    role: session.user.role,
  };
  // Original IP + fingerprint checks below are unreachable (intentionally)
"""
    
    content = content[:line_end] + early_return + content[line_end:]
    print(f"Inserted early return at position {line_end}")
else:
    print("ERROR: expiresAt marker not found")

with open("/tmp/fixed-auth-v2.ts", "w") as f:
    f.write(content)
print(f"Fixed auth.ts: {len(content)} bytes, {content.count(chr(10))} lines")
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Upload fix script
sftp = client.open_sftp()
with sftp.file('/tmp/fix-auth-early-return.py', 'w') as f:
    f.write(FIX)
sftp.close()

# Run fix
print("=== Apply fix ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "python3 /tmp/fix-auth-early-return.py",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Copy to container
print("\n=== Copy to container ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/fixed-auth-v2.ts kali:/opt/rara-agent/src/lib/auth.ts && "
    "echo copied",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Rebuild + restart + test
print("\n=== Rebuild ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -5"
    "'",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart + test
print("\n=== Restart + test ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== Auth flow ==='; "
    "RESP=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' --max-time 10 2>/dev/null); "
    "echo \"POST: $(echo $RESP | head -c 150)\"; "
    "TOKEN=$(echo \"$RESP\" | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo; echo \"GET /api/auth:\"; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 200; "
    "echo; echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
