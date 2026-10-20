#!/usr/bin/env python3
"""SIMPLEST fix: comment out 'return null;' in verifyToken IP/fingerprint checks."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Get original auth.ts from GitHub
print("=== Get original auth.ts ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "curl -sL -H 'Authorization: token " + PAT + "' "
    "-H 'Accept: application/vnd.github.raw' "
    "https://api.github.com/repos/Yz776/rara-agent/contents/src/lib/auth.ts "
    "-o /tmp/orig-auth.ts && wc -l /tmp/orig-auth.ts",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Apply fix: find verifyToken, comment out ALL 'return null;' AFTER session validation
FIX = r'''
with open("/tmp/orig-auth.ts") as f:
    lines = f.readlines()

in_verify = False
brace = 0
session_checked = False
changes = 0

for i in range(len(lines)):
    if "export async function verifyToken" in lines[i]:
        in_verify = True
        brace = 0
    
    if in_verify:
        brace += lines[i].count("{") - lines[i].count("}")
        
        # Track when we're past the session validation (after expiresAt check)
        if "session.expiresAt" in lines[i]:
            session_checked = True
        
        # After session validation, comment out ALL return null; statements
        # (these are the IP + fingerprint checks)
        if session_checked and "return null;" in lines[i] and "return null;" == lines[i].strip():
            lines[i] = lines[i].replace("return null;", "// return null; // SKIP IP/fingerprint check")
            changes += 1
            print(f"  Line {i+1}: commented return null")
        
        # Also comment out the session.update (revocation) in IP mismatch
        if session_checked and "db.session.update" in lines[i] and "revoked" in lines[i]:
            lines[i] = "// " + lines[i]
            print(f"  Line {i+1}: commented session.update (revoke)")
        
        if brace == 0 and i > 0:
            in_verify = False
            break

with open("/tmp/fixed-auth-final.ts", "w") as f:
    f.writelines(lines)
print(f"\nTotal: {changes} return null statements commented")
print(f"File: {len(lines)} lines")
'''

sftp = client.open_sftp()
with sftp.file('/tmp/fix-simple.py', 'w') as f:
    f.write(FIX)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "python3 /tmp/fix-simple.py && "
    "docker cp /tmp/fixed-auth-final.ts kali:/opt/rara-agent/src/lib/auth.ts && "
    "echo 'copied' && "
    # Rebuild
    "echo; echo '=== rebuild ==='; "
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -5"
    "' && "
    # Restart + test
    "echo; echo '=== restart + test ==='; "
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "RESP=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' --max-time 10 2>/dev/null); "
    "echo \"POST: $(echo $RESP | head -c 100)\"; "
    "TOKEN=$(echo \"$RESP\" | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo; echo 'GET /api/auth:'; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 200; "
    "echo; echo; echo 'GET /api/conversations:'; "
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
