#!/usr/bin/env python3
"""Fix: use /* */ block comments to comment out IP + fingerprint check sections."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Download original auth.ts
print("=== Get original auth.ts ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "curl -sL -H 'Authorization: token " + PAT + "' "
    "-H 'Accept: application/vnd.github.raw' "
    "https://api.github.com/repos/Yz776/rara-agent/contents/src/lib/auth.ts "
    "-o /tmp/orig-auth.ts && wc -l /tmp/orig-auth.ts",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Apply fix with Python — wrap IP + fingerprint check blocks in /* */
FIX = r'''
with open("/tmp/orig-auth.ts") as f:
    content = f.read()

# Find "IP BINDING" marker and wrap everything from there until the return statement
# in a /* */ block comment
ip_marker = "IP BINDING"
ip_idx = content.find(ip_marker)
if ip_idx < 0:
    ip_marker = "IP BINDING CHECK"
    ip_idx = content.find(ip_marker)

if ip_idx >= 0:
    # Find the start of the comment block (go back to start of line)
    line_start = content.rfind("\n", 0, ip_idx) + 1
    
    # Find the end — look for the next "return {" statement after the IP check
    # This is the return statement that comes after all checks pass
    ret_idx = content.find("return {", ip_idx)
    if ret_idx >= 0:
        # Go back to start of that line
        ret_line_start = content.rfind("\n", 0, ret_idx) + 1
        
        # Wrap everything between line_start and ret_line_start in /* */
        block = content[line_start:ret_line_start]
        content = content[:line_start] + "/*\n  IP + Fingerprint checks disabled for keyless access\n" + block + "*/\n" + content[ret_line_start:]
        print(f"Wrapped {len(block)} chars of IP/fingerprint checks in /* */ comment")
    else:
        print("ERROR: return { not found after IP check")
else:
    print("ERROR: IP BINDING marker not found")

with open("/tmp/fixed-auth-block.ts", "w") as f:
    f.write(content)
print(f"Result: {len(content)} bytes, {content.count(chr(10))} lines")
'''

sftp = client.open_sftp()
with sftp.file('/tmp/fix-block-comment.py', 'w') as f:
    f.write(FIX)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "python3 /tmp/fix-block-comment.py && "
    "docker cp /tmp/fixed-auth-block.ts kali:/opt/rara-agent/src/lib/auth.ts && "
    "echo copied && "
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
