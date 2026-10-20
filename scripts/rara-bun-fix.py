#!/usr/bin/env python3
"""Fix: install bun at /root/.bun (not /data/root/.bun) in running container."""
import paramiko, base64, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

print("=== Step 1: Install bun at /root/.bun in running container ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    # Install bun to /root/.bun (NOT /data/root/.bun which is shadowed by volume mount)
    "docker exec kali sh -c 'BUN_INSTALL=/root/.bun curl -fsSL https://bun.sh/install | bash' 2>&1 | tail -5; "
    "echo; echo '=== verify bun ==='; "
    "docker exec kali /root/.bun/bin/bun --version 2>&1 | head -1; "
    "echo; echo '=== update run scripts to use full bun path ==='; "
    "docker exec kali sed -i 's|exec bun|exec /root/.bun/bin/bun|g' /usr/local/bin/run-rara-web.sh /usr/local/bin/run-rara-zrouter.sh; "
    "docker exec kali sed -i 's|bun run|/root/.bun/bin/bun run|g' /usr/local/bin/run-rara-web.sh /usr/local/bin/run-rara-zrouter.sh; "
    "docker exec kali sed -i 's|bunx |/root/.bun/bin/bunx |g' /usr/local/bin/run-rara-web.sh; "
    "echo; echo '=== verify run-rara-web.sh ==='; "
    "docker exec kali cat /usr/local/bin/run-rara-web.sh 2>&1 | head -20; "
    "echo; echo '=== restart rara apps ==='; "
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
    "echo; echo '=== HTTP test rara-web ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3",
    timeout=120
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
