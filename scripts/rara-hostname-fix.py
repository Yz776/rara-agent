#!/usr/bin/env python3
"""Fix: override HOSTNAME=0.0.0.0 in run-rara-web.sh."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Rewrite run-rara-web.sh with HOSTNAME=0.0.0.0
print("=== Rewrite run-rara-web.sh with HOSTNAME=0.0.0.0 ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cat > /usr/local/bin/run-rara-web.sh << \"RARAEOF\"\n"
    "#!/usr/bin/env bash\n"
    "set -euo pipefail\n"
    "cd /opt/rara-agent\n"
    ": \"${KFAI_AUTH_SECRET:?must be set}\"\n"
    ": \"${KROUTER_INTERNAL_TOKEN:?must be set}\"\n"
    ": \"${KROUTER_ADMIN_PASSWORD:?must be set}\"\n"
    "export NODE_ENV=production\n"
    "export HOST=0.0.0.0\n"
    "export HOSTNAME=0.0.0.0\n"
    "export PORT=\"${RARA_PORT:-3002}\"\n"
    "export DATABASE_URL=\"${DATABASE_URL:-file:/data/apps/rara-agent/db/rara.db}\"\n"
    "export KROUTER_BASE=\"${KROUTER_BASE:-http://127.0.0.1:3001}\"\n"
    "export MCP_ENDPOINT=\"${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp}\"\n"
    "export RARA_BASE_URL=\"${RARA_BASE_URL:-http://127.0.0.1:3002}\"\n"
    "/root/.bun/bin/bun run db:push --accept-data-loss 2>/dev/null || true\n"
    "exec node .next/standalone/server.js\n"
    "RARAEOF\n"
    "chmod +x /usr/local/bin/run-rara-web.sh\n"
    "echo done'"
    " 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart rara-web
print("\n=== Restart rara-web ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 15; "
    "echo; echo '=== rara-web logs ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(3001|3002|3003)' | head -5; "
    "echo; echo '=== HTTP rara-web ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -5; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3; "
    "echo; echo '=== PM2 STATUS ==='; "
    "docker exec kali pm2 list 2>&1 | head -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
