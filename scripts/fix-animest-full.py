#!/usr/bin/env python3
"""Fix animest 503: check dist/ + build frontend + install MongoDB."""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Check animest structure
print("=== Check animest structure ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /data/apps/animest && "
    "echo \"=== ls ===\"; ls -la | head -15; "
    "echo; echo \"=== dist/ exists? ===\"; ls -la dist/ 2>&1 | head -5; "
    "echo; echo \"=== server/index.ts exists? ===\"; ls -la server/index.ts 2>&1; "
    "echo; echo \"=== check env vars ===\"; grep -E \"MONGO|DATABASE|DB_|PORT\" .env 2>&1 | head -10; "
    "echo; echo \"=== check if mongod is running ===\"; pgrep mongod 2>&1; "
    "echo; echo \"=== check animest server code for 503 ===\"; grep -n '503' server/index.ts 2>&1 | head -5"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Build frontend (vite build)
print("\n=== Build animest frontend (vite build) ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /data/apps/animest && "
    "/root/.bun/bin/bun run build 2>&1 | tail -15"
    "'",
    timeout=120
)
print(stdout.read().decode("utf-8", errors="replace"))

# Install MongoDB from official repo
print("\n=== Install MongoDB 7.0 ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "wget -qO- https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg 2>&1 | tail -2; "
    "echo \"deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] http://repo.mongodb.org/apt/ubuntu noble/mongodb-org/7.0 multiverse\" > /etc/apt/sources.list.d/mongodb-org-7.0.list; "
    "apt-get update -qq 2>&1 | tail -3; "
    "DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org 2>&1 | tail -5; "
    "echo; echo \"=== start mongod ===\"; "
    "mkdir -p /data/db /var/log/mongodb; "
    "mongod --dbpath /data/db --fork --logpath /var/log/mongodb/mongod.log --bind_ip 127.0.0.1 --port 27017 2>&1; "
    "sleep 3; "
    "echo; echo \"=== test mongo ===\"; "
    "mongosh --eval \"db.runCommand({ping:1})\" 2>&1 | head -5 || mongod --version 2>&1 | head -1"
    "'",
    timeout=180
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart animest + test
print("\n=== Restart animest + test wotanime ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart animest --update-env 2>&1 | head -3; "
    "sleep 15; "
    "echo; echo '=== wotanime test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://wotanime.my.id/ 2>&1; "
    "echo; echo '=== local wotanime ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: wotanime.my.id' http://127.0.0.1:80/ 2>&1; "
    "echo; echo '=== animest logs ==='; "
    "docker exec kali pm2 logs animest --lines 10 --nostream 2>&1 | tail -15; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id bot.kangwifi.eu.org game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
