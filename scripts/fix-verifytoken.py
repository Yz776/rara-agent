#!/usr/bin/env python3
"""Fix verifyToken in auth.ts — skip ALL checks, just check token exists in DB."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Check current auth.ts verifyToken function
print("=== Current verifyToken in auth.ts ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cd /opt/rara-agent && grep -n -A20 \"export async function verifyToken\" src/lib/auth.ts 2>&1 | head -25'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Also check what API routes use verifyToken
print("\n=== API routes using verifyToken ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cd /opt/rara-agent && grep -rn \"verifyToken\\|bearerFromHeaders\\|authenticate\" src/app/api/ 2>&1 | head -15'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Fix: replace verifyToken with a version that ONLY checks token exists in DB
print("\n=== Fix verifyToken ===", flush=True)

FIX_SCRIPT = r'''import re

with open("src/lib/auth.ts") as f:
    content = f.read()

# Find verifyToken function and replace it entirely
# Match: export async function verifyToken(... { ... }
pattern = r'export async function verifyToken\(.*?\{.*?\n\}'
match = re.search(pattern, content, re.DOTALL)

if match:
    old_func = match.group(0)
    print(f"Found verifyToken ({len(old_func)} chars)")

    new_func = """export async function verifyToken(token: string, _ip?: string, _deviceFingerprint?: string): Promise<SessionRecord | undefined> {
  // SIMPLIFIED: skip IP + fingerprint check — just verify token exists in DB
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if ((row.expires_at as number) < Date.now()) return undefined;
    return {
      token: row.token as string,
      userId: row.user_id as string,
      expiresAt: row.expires_at as number,
      userAgent: row.user_agent as string | undefined,
      ipAddress: row.ip_address as string | undefined,
      createdAt: row.created_at as number,
    };
  } catch {
    return undefined;
  }
}"""

    content = content.replace(old_func, new_func)
    print("verifyToken replaced with simplified version")
else:
    print("verifyToken not found — trying alternative approach")
    # Maybe the function signature is different
    idx = content.find("export async function verifyToken")
    if idx >= 0:
        # Find the closing brace
        brace = 0
        end = idx
        for i in range(idx, len(content)):
            if content[i] == '{': brace += 1
            elif content[i] == '}':
                brace -= 1
                if brace == 0:
                    end = i + 1
                    break
        old_func = content[idx:end]
        print(f"Found verifyToken at pos {idx}-{end} ({len(old_func)} chars)")
        new_func = """export async function verifyToken(token: string, _ip?: string, _deviceFingerprint?: string): Promise<SessionRecord | undefined> {
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if ((row.expires_at as number) < Date.now()) return undefined;
    return {
      token: row.token as string,
      userId: row.user_id as string,
      expiresAt: row.expires_at as number,
      userAgent: row.user_agent as string | undefined,
      ipAddress: row.ip_address as string | undefined,
      createdAt: row.created_at as number,
    };
  } catch {
    return undefined;
  }
}"""
        content = content[:idx] + new_func + content[end:]
        print("verifyToken replaced (alternative)")
    else:
        print("ERROR: verifyToken not found at all")

with open("src/lib/auth.ts", 'w') as f:
    f.write(content)
print(f"auth.ts: {len(content)} bytes")
'''

sftp = client.open_sftp()
with sftp.file('/tmp/fix-auth.py', 'w') as f:
    f.write(FIX_SCRIPT)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/fix-auth.py kali:/tmp/fix-auth.py && "
    "docker exec kali bash -c 'cd /opt/rara-agent && python3 /tmp/fix-auth.py'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Rebuild + restart + test
print("\n=== Rebuild + restart ===", flush=True)
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
    "echo; echo '=== POST /api/auth ==='; "
    "TOKEN=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "echo \"Token: ${TOKEN:0:10}...\"; "
    "echo; echo '=== GET /api/auth with token ==='; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth --max-time 10 2>&1 | head -3; "
    "echo; echo '=== GET /api/conversations ==='; "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/conversations --max-time 10 2>&1 | head -3; "
    "echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
