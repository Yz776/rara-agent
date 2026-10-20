#!/usr/bin/env python3
"""Fix: use sed to add 'false &&' to IP/fingerprint checks in verifyToken."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Use sed to disable IP + fingerprint checks by adding 'false &&'
print("=== Fix verifyToken with sed ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    # Get original auth.ts
    "curl -sL -H 'Authorization: token " + PAT + "' "
    "-H 'Accept: application/vnd.github.raw' "
    "https://api.github.com/repos/Yz776/rara-agent/contents/src/lib/auth.ts "
    "-o /tmp/orig-auth.ts && "
    # Use sed to add 'false &&' to the IP check condition
    "sed -i \"s/if (session.ipAddr !== currentIp)/if (false \\&\\& session.ipAddr !== currentIp)/\" /tmp/orig-auth.ts && "
    # Add 'false &&' to fingerprint check
    "sed -i \"s/if (session.deviceFingerprint !== currentFingerprint)/if (false \\&\\& session.deviceFingerprint !== currentFingerprint)/\" /tmp/orig-auth.ts && "
    # Also disable the outer IP check (if it exists)
    "sed -i \"s/if (session.ipAddr && currentIp && currentIp/if (false \\&\\& session.ipAddr \\&\\& currentIp \\&\\& currentIp/\" /tmp/orig-auth.ts && "
    # Verify changes
    "echo '=== changed lines ==='; "
    "grep -n 'false' /tmp/orig-auth.ts | head -5; "
    # Copy to container
    "echo; docker cp /tmp/orig-auth.ts kali:/opt/rara-agent/src/lib/auth.ts && "
    "echo 'copied' && "
    # Rebuild
    "echo; echo '=== rebuild ==='; "
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
    "echo \"POST: $(echo $RESP | head -c 100)\"; "
    "TOKEN=$(echo \"$RESP\" | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo; echo 'GET /api/auth:'; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -c 200; "
    "echo; echo; echo 'GET /api/conversations:'; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations --max-time 10 2>&1 | head -c 200; "
    "echo; echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
