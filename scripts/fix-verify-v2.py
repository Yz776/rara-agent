#!/usr/bin/env python3
"""Fix verifyToken — just comment out IP + fingerprint checks, keep everything else."""
import paramiko

FIX = r'''with open("src/lib/auth.ts") as f:
    lines = f.readlines()

new_lines = []
in_verify = False
brace = 0
for i, line in enumerate(lines):
    if "export async function verifyToken" in line:
        in_verify = True
        brace = 0
    
    if in_verify:
        # Track braces
        brace += line.count("{") - line.count("}")
        
        # Comment out IP check lines
        if "ipAddr" in line and ("return" in line or "!== " in line):
            new_lines.append("// " + line)
            print(f"  Line {i+1} commented: {line.rstrip()}")
            continue
        # Comment out fingerprint check lines  
        if "fingerprint" in line and ("return" in line or "!== " in line or "deviceFingerprint" in line):
            new_lines.append("// " + line)
            print(f"  Line {i+1} commented: {line.rstrip()}")
            continue
        # Comment out IP binding check section header
        if "IP BINDING" in line:
            new_lines.append("// " + line)
            print(f"  Line {i+1} commented: IP binding header")
            continue
        
        new_lines.append(line)
        
        if brace == 0 and i > 0:
            in_verify = False
    else:
        new_lines.append(line)

with open("src/lib/auth.ts", "w") as f:
    f.writelines(new_lines)
print(f"Done: {len(new_lines)} lines")
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# First restore the original auth.ts from backup
print("=== Restore auth.ts from backup ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cd /opt/rara-agent && cp src/lib/auth.ts.bak src/lib/auth.ts 2>/dev/null || echo no backup'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Upload + apply the fix
sftp = client.open_sftp()
with sftp.file('/tmp/fix-auth-v2.py', 'w') as f:
    f.write(FIX)
sftp.close()

print("\n=== Apply fix ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/fix-auth-v2.py kali:/tmp/fix-auth-v2.py && "
    "docker exec kali bash -c 'cd /opt/rara-agent && python3 /tmp/fix-auth-v2.py'",
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
    # Test auth flow
    "echo; echo '=== POST /api/auth ==='; "
    "RESP=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' --max-time 10 2>/dev/null); "
    "echo \"$RESP\" | head -c 200; "
    "TOKEN=$(echo \"$RESP\" | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo; echo \"Token: ${TOKEN:0:10}...\"; "
    "echo; echo '=== GET /api/auth with token ==='; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 300; "
    "echo; echo; echo '=== GET /api/conversations ==='; "
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
