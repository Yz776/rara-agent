#!/usr/bin/env python3
"""
Step 4-6: Fix catur port (3000→3003), update nginx config, reload, test.
- bot.kangwifi.eu.org  → port 3000 (WhatsApp bot / bot-amd64)
- game.kangwifi.eu.org → port 3003 (catur)
- wotanime.my.id       → port 3051 (animest)
- rara.ai.id           → port 3002 (rara-web)
- storage.kangwifi.eu.org → port 47291 (cloud-storage)
"""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Step 4: Fix catur PORT=3000 → PORT=3003 (avoid conflict with bot-amd64)
print("=== Step 4: Fix catur port (3000 → 3003) ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cd /data/apps/catur && sed -i \"s/PORT=3000/PORT=3003/\" .env && cat .env | head -5'; "
    "echo; echo '=== restart catur ==='; "
    "docker exec kali pm2 restart catur --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== catur status ==='; "
    "docker exec kali pm2 list 2>&1 | grep catur; "
    "echo; echo '=== catur logs ==='; "
    "docker exec kali pm2 logs catur --lines 5 --nostream 2>&1 | tail -10; "
    "echo; echo '=== check port 3003 ==='; "
    "ss -tlnp | grep ':3003' | head -3",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 5: Update nginx config with new domain mapping
print("\n=== Step 5: Update nginx config ===", flush=True)

nginx_config = r'''# Rara Agent + Kali-Linux reverse proxy v2
# Domain mapping:
#   rara.ai.id              → 3002 (rara-web Next.js + 3D Rara)
#   bot.kangwifi.eu.org     → 3000 (WhatsApp bot / bot-amd64)
#   game.kangwifi.eu.org    → 3003 (catur / Neon Chess)
#   storage.kangwifi.eu.org → 47291 (cloud-storage S3)
#   wotanime.my.id          → 3051 (animest)

upstream rara_web { server 127.0.0.1:3002; }
upstream bot_wa { server 127.0.0.1:3000; }
upstream catur_game { server 127.0.0.1:3003; }
upstream cloud_storage { server 127.0.0.1:47291; }
upstream animest_app { server 127.0.0.1:3051; }

# SSL cert (self-signed — Cloudflare Full mode accepts this)
ssl_certificate /etc/nginx/ssl/selfsigned.crt;
ssl_certificate_key /etc/nginx/ssl/selfsigned.key;

# Default server (rara.ai.id)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name rara.ai.id _;
    location / {
        proxy_pass http://rara_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# bot.kangwifi.eu.org → WhatsApp bot
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name bot.kangwifi.eu.org;
    location / {
        proxy_pass http://bot_wa;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# game.kangwifi.eu.org → catur (Neon Chess)
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name game.kangwifi.eu.org;
    location / {
        proxy_pass http://catur_game;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# storage.kangwifi.eu.org → cloud-storage
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name storage.kangwifi.eu.org;
    location / {
        proxy_pass http://cloud_storage;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# wotanime.my.id → animest
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name wotanime.my.id;
    location / {
        proxy_pass http://animest_app;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
'''

# Upload config via SFTP
sftp = client.open_sftp()
with sftp.file('/tmp/rara-nginx-v2.conf', 'w') as f:
    f.write(nginx_config)
sftp.close()
print("  nginx v2 config uploaded", flush=True)

# Apply config + reload
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/rara-nginx-v2.conf kali:/etc/nginx/conf.d/rara-nginx.conf; "
    "docker exec kali nginx -t 2>&1; "
    "docker exec kali nginx -s reload 2>&1; "
    "sleep 3; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(80|443|3000|3001|3002|3003|3051|47291|8090)' | head -15",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 6: Test ALL domains
print("\n=== Step 6: Test all domains ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== Local tests (via Host header) ==='; "
    "for D in rara.ai.id bot.kangwifi.eu.org game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" http://127.0.0.1:80/ 2>/dev/null); "
    "  echo \"  $D (HTTP) → $CODE\"; "
    "done; "
    "echo; echo '=== External tests (via Cloudflare HTTPS) ==='; "
    "for D in rara.ai.id bot.kangwifi.eu.org game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → $CODE\"; "
    "done; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -3; "
    "echo; echo '=== FINAL PM2 STATUS ==='; "
    "docker exec kali pm2 list 2>&1 | head -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
