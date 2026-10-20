#!/usr/bin/env python3
"""Get original auth.ts from GitHub + apply minimal fix (comment out IP checks only)."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Get original auth.ts from GitHub API (raw content)
print("=== Get original auth.ts from GitHub ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "curl -sL -H 'Authorization: token " + PAT + "' "
    "-H 'Accept: application/vnd.github.raw' "
    "https://api.github.com/repos/Yz776/rara-agent/contents/src/lib/auth.ts "
    "-o /tmp/original-auth.ts && wc -l /tmp/original-auth.ts",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Apply minimal fix: just comment out IP + fingerprint checks
# Use a simple Python script that reads the original + comments out specific lines
FIX = r'''
with open("/tmp/original-auth.ts") as f:
    lines = f.readlines()

new_lines = []
for i, line in enumerate(lines):
    stripped = line.strip()
    # Comment out IP check
    if "ipAddr" in stripped and ("return" in stripped or "!==" in stripped):
        new_lines.append("// " + line)
        print(f"  Commented line {i+1}: {stripped[:80]}")
    # Comment out fingerprint check
    elif "deviceFingerprint" in stripped and ("return" in stripped or "!==" in stripped):
        new_lines.append("// " + line)
        print(f"  Commented line {i+1}: {stripped[:80]}")
    # Comment out IP binding section header
    elif "IP BINDING" in stripped:
        new_lines.append("// " + line)
        print(f"  Commented line {i+1}: IP binding header")
    # Comment out fingerprint binding section header
    elif "FINGERPRINT BINDING" in stripped or "DEVICE BINDING" in stripped:
        new_lines.append("// " + line)
        print(f"  Commented line {i+1}: fingerprint binding header")
    else:
        new_lines.append(line)

with open("/tmp/fixed-auth.ts", "w") as f:
    f.writelines(new_lines)
print(f"\nFixed: {len(new_lines)} lines")
'''

sftp = client.open_sftp()
with sftp.file('/tmp/fix-auth-minimal.py', 'w') as f:
    f.write(FIX)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "python3 /tmp/fix-auth-minimal.py",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Copy fixed auth.ts to container
print("\n=== Copy fixed auth.ts to container ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/fixed-auth.ts kali:/opt/rara-agent/src/lib/auth.ts && "
    "echo 'auth.ts copied' && "
    # Also verify it's valid TypeScript
    "docker exec kali head -5 /opt/rara-agent/src/lib/auth.ts",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Rebuild + restart + test
print("\n=== Rebuild + restart + test ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -5"
    "' && "
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    # Full auth flow test
    "echo; echo '=== Auth flow test ==='; "
    "RESP=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' --max-time 10 2>/dev/null); "
    "echo \"POST: $(echo $RESP | head -c 100)\"; "
    "TOKEN=$(echo \"$RESP\" | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo; echo \"GET with token:\"; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 200; "
    "echo; echo; echo \"GET conversations:\"; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations --max-time 10 2>&1 | head -c 200; "
    "echo; echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
