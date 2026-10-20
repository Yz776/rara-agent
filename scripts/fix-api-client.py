#!/usr/bin/env python3
"""Fix: update api-client.ts login() function to skip fingerprint + rebuild."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Replace the login() function in api-client.ts with simplified version
print("=== Fix api-client.ts login() function ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    # Use Python to replace the login function
    "python3 << \"PYEOF\"\n"
    "import re\n"
    "with open('src/lib/api-client.ts') as f:\n"
    "    content = f.read()\n"
    "\n"
    "# Replace the login function with simplified version (no fingerprint)\n"
    "new_login = \"\"\"export async function login(renderTimestamp: number): Promise<LoginResponse> {\n"
    "  const body = { _ts: renderTimestamp, _fp: 'skip', _bh: 'skip', _hp: '' };\n"
    "  const res = await fetch('/api/auth', {\n"
    "    method: 'POST',\n"
    "    headers: { 'Content-Type': 'application/json' },\n"
    "    body: JSON.stringify(body),\n"
    "  });\n"
    "  const j = await res.json().catch(() => ({}));\n"
    "  if (!res.ok) throw new Error(j.error || `Login gagal (${res.status})`);\n"
    "  return j as LoginResponse;\n"
    "}\n"
    "\"\"\"\n"
    "\n"
    "# Find old login function and replace it\n"
    "pattern = r'export async function login\\(renderTimestamp: number\\).*?^}\\n'\n"
    "new_content = re.sub(pattern, new_login, content, flags=re.MULTILINE | re.DOTALL)\n"
    "\n"
    "if new_content == content:\n"
    "    print('WARNING: login function not found — trying manual replace')\n"
    "    # Find start and end manually\n"
    "    start = content.find('export async function login(')\n"
    "    if start >= 0:\n"
    "        # Find the closing brace at the same indent level\n"
    "        brace_count = 0\n"
    "        end = start\n"
    "        for i in range(start, len(content)):\n"
    "            if content[i] == '{':\n"
    "                brace_count += 1\n"
    "            elif content[i] == '}':\n"
    "                brace_count -= 1\n"
    "                if brace_count == 0:\n"
    "                    end = i + 1\n"
    "                    break\n"
    "        new_content = content[:start] + new_login.strip() + content[end:]\n"
    "        print(f'Replaced login function (chars {start}-{end})')\n"
    "    else:\n"
    "        print('ERROR: login function not found at all')\n"
    "else:\n"
    "    print(f'Replaced login function via regex')\n"
    "\n"
    "with open('src/lib/api-client.ts', 'w') as f:\n"
    "    f.write(new_content)\n"
    "print(f'File size: {len(new_content)} bytes')\n"
    "PYEOF\n"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Verify the change
print("\n=== Verify login function ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali grep -A10 'export async function login' /opt/rara-agent/src/lib/api-client.ts 2>&1 | head -15",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Rebuild Next.js
print("\n=== Rebuild Next.js ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /opt/rara-agent && "
    "export NODE_OPTIONS=\"--max-old-space-size=4096 --max-semi-space-size=128\" && "
    "export DATABASE_URL=file:/tmp/rara-build-validate.db && "
    "export NEXT_TELEMETRY_DISABLED=1 && "
    "/root/.bun/bin/bun run build 2>&1 | tail -10"
    "'",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart rara-web
print("\n=== Restart rara-web ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== POST /api/auth test ==='; "
    "curl -s -X POST http://localhost:3002/api/auth "
    "-H 'Content-Type: application/json' "
    "-H 'User-Agent: Mozilla/5.0 (test)' "
    "-d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' "
    "-w '\\nHTTP %{http_code}\\n' --max-time 10 2>&1 | head -5; "
    "echo; echo '=== rara.ai.id test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))

# Save PM2
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
