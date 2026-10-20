#!/usr/bin/env python3
"""Fix: check .next/standalone/server.js + rewrite scripts correctly."""
import paramiko, base64, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

print("=== Step 1: Check /opt/rara-agent/.next/standalone/server.js ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali ls -la /opt/rara-agent/.next/standalone/server.js 2>&1; "
    "echo; echo '=== ls .next/ ==='; "
    "docker exec kali ls /opt/rara-agent/.next/ 2>&1 | head -10; "
    "echo; echo '=== ls .next/standalone/ ==='; "
    "docker exec kali ls /opt/rara-agent/.next/standalone/ 2>&1 | head -10",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

print("\n=== Step 2: If server.js missing, build it ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cd /opt/rara-agent && "
    "  if [ ! -f .next/standalone/server.js ]; then "
    "    echo \"server.js missing — running bun run build...\"; "
    "    DATABASE_URL=file:/tmp/rara-build-validate.db NEXT_TELEMETRY_DISABLED=1 "
    "    /root/.bun/bin/bun run build 2>&1 | tail -15; "
    "  else "
    "    echo \"server.js exists\"; "
    "  fi'",
    timeout=300
)
print(stdout.read().decode("utf-8", errors="replace"))

print("\n=== Step 3: Rewrite run scripts correctly (no sed double-replacement) ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cat > /usr/local/bin/run-rara-web.sh << \"RARAEOF\"\n"
    "#!/usr/bin/env bash\n"
    "set -euo pipefail\n"
    "cd /opt/rara-agent\n"
    ": \"${KFAI_AUTH_SECRET:?must be set}\"\n"
    ": \"${KROUTER_INTERNAL_TOKEN:?must be set}\"\n"
    ": \"${KROUTER_ADMIN_PASSWORD:?must be set}\"\n"
    "export NODE_ENV=production HOST=0.0.0.0 PORT=\"${RARA_PORT:-3002}\"\n"
    "export DATABASE_URL=\"${DATABASE_URL:-file:/data/apps/rara-agent/db/rara.db}\"\n"
    "export KROUTER_BASE=\"${KROUTER_BASE:-http://127.0.0.1:3001}\"\n"
    "export MCP_ENDPOINT=\"${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp}\"\n"
    "export RARA_BASE_URL=\"${RARA_BASE_URL:-http://127.0.0.1:3002}\"\n"
    "/root/.bun/bin/bun run db:push --accept-data-loss 2>/dev/null || true\n"
    "exec /root/.bun/bin/bun .next/standalone/server.js\n"
    "RARAEOF\n"
    "chmod +x /usr/local/bin/run-rara-web.sh\n"
    "echo \"run-rara-web.sh rewritten\"\n'"
    " 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cat > /usr/local/bin/run-rara-zrouter.sh << \"RARAZEOF\"\n"
    "#!/usr/bin/env bash\n"
    "set -euo pipefail\n"
    "cd /opt/rara-agent\n"
    ": \"${KROUTER_INTERNAL_TOKEN:?must be set}\"\n"
    ": \"${KROUTER_ADMIN_USERNAME:-admin}\"\n"
    ": \"${KROUTER_ADMIN_PASSWORD:?must be set}\"\n"
    "export NODE_ENV=production HOST=127.0.0.1 PORT=\"${ZROUTER_PORT:-3001}\"\n"
    "export KROUTER_DATA_DIR=\"${KROUTER_DATA_DIR:-/data/apps/rara-agent/mini-services/zrouter/data}\"\n"
    "exec /root/.bun/bin/bun run mini-services/zrouter/src/index.ts\n"
    "RARAZEOF\n"
    "chmod +x /usr/local/bin/run-rara-zrouter.sh\n"
    "echo \"run-rara-zrouter.sh rewritten\"\n'"
    " 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

print("\n=== Step 4: Restart rara apps ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web rara-zrouter --update-env 2>&1 | head -5; "
    "sleep 15; "
    "echo; echo '=== PM2 status ==='; "
    "docker exec kali pm2 list 2>&1 | head -20; "
    "echo; echo '=== rara-web logs ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== rara-zrouter logs ==='; "
    "docker exec kali pm2 logs rara-zrouter --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(3001|3002)' | head -5; "
    "echo; echo '=== HTTP rara-web ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
