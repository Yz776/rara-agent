#!/usr/bin/env python3
"""Check original verifyToken return shape + fix to match."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Get the original auth.ts + check the return statement at the end of verifyToken
print("=== Original auth.ts — verifyToken return statement ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "cat /tmp/original-auth.ts | grep -n 'return {' -A 10 | head -20",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Also check AuthContext type
print("\n=== AuthContext type ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "cat /tmp/original-auth.ts | grep -n 'AuthContext' -A 10 | head -15",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Now apply the correct fix — use the EXACT return shape from the original
print("\n=== Apply correct fix ===", flush=True)

FIX = r'''
with open("/tmp/original-auth.ts") as f:
    content = f.read()

# Find the expiresAt check line
marker = "if (session.expiresAt.getTime() < Date.now()) return null;"
idx = content.find(marker)
if idx < 0:
    # Try partial match
    idx = content.find("session.expiresAt")
    if idx >= 0:
        line_end = content.find("\n", idx)
        marker = content[idx:line_end+1]
        print(f"Found marker: {marker.strip()}")
    
if idx >= 0:
    line_end = content.find("\n", idx) + 1
    
    # Find the ORIGINAL return statement at the end of verifyToken
    # It's the last "return {" before the closing brace
    ret_idx = content.rfind("return {")
    if ret_idx >= 0:
        ret_end = content.find("};", ret_idx) + 2
        original_return = content[ret_idx:ret_end]
        print(f"Original return: {original_return.strip()[:100]}...")
        
        # Insert the same return statement right after the expiresAt check
        early_return = "\n  // SKIP IP + fingerprint checks — return immediately\n  " + original_return + "\n"
        content = content[:line_end] + early_return + content[line_end:]
        print("Early return inserted")
    else:
        print("ERROR: return statement not found")
else:
    print("ERROR: expiresAt marker not found")

with open("/tmp/fixed-auth-v3.ts", "w") as f:
    f.write(content)
print(f"Result: {len(content)} bytes")
'''

sftp = client.open_sftp()
with sftp.file('/tmp/fix-auth-v3.py', 'w') as f:
    f.write(FIX)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "python3 /tmp/fix-auth-v3.py && "
    "docker cp /tmp/fixed-auth-v3.ts kali:/opt/rara-agent/src/lib/auth.ts && "
    "echo 'auth.ts copied' && "
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
    "echo; echo '=== restart ==='; "
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    # Test auth
    "echo; echo '=== auth test ==='; "
    "RESP=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' --max-time 10 2>/dev/null); "
    "echo \"POST: $(echo $RESP | head -c 100)\"; "
    "TOKEN=$(echo \"$RESP\" | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo; echo 'GET /api/auth:'; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 200; "
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
