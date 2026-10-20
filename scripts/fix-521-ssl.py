#!/usr/bin/env python3
"""
Fix 521: set up HTTPS on origin with self-signed cert.
Cloudflare "Full" mode accepts self-signed certs.
"""
import paramiko, time

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Step 1: Generate self-signed SSL cert in the container
print("=== Step 1: Generate self-signed SSL cert ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "mkdir -p /etc/nginx/ssl && "
    "openssl req -x509 -nodes -days 3650 -newkey rsa:2048 "
    "-keyout /etc/nginx/ssl/selfsigned.key "
    "-out /etc/nginx/ssl/selfsigned.crt "
    "-subj /CN=*.ai.id/O=Rara/C=ID 2>&1'"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Step 2: Update nginx config to also listen on 443
print("\n=== Step 2: Update nginx config (add 443) ===", flush=True)

nginx_config = r'''# Rara Agent + Kali-Linux reverse proxy with HTTPS (self-signed for Cloudflare Full mode)

upstream rara_web { server 127.0.0.1:3002; }
upstream cloud_storage { server 127.0.0.1:47291; }
upstream game_arena { server 127.0.0.1:3000; }
upstream animest { server 127.0.0.1:3051; }

# HTTP server — redirect to HTTPS (for Full mode) + serve directly (for Flexible mode)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    # Don't redirect — Cloudflare Flexible mode needs HTTP here
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

# HTTPS server (self-signed cert — Cloudflare Full mode accepts this)
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    
    ssl_certificate /etc/nginx/ssl/selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/selfsigned.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    
    location / {
        proxy_pass http://rara_web;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# storage.kangwifi.eu.org
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name storage.kangwifi.eu.org;
    ssl_certificate /etc/nginx/ssl/selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/selfsigned.key;
    location / {
        proxy_pass http://cloud_storage;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# game.kangwifi.eu.org
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name game.kangwifi.eu.org;
    ssl_certificate /etc/nginx/ssl/selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/selfsigned.key;
    location / {
        proxy_pass http://game_arena;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# wotanime.my.id
server {
    listen 80; listen [::]:80;
    listen 443 ssl; listen [::]:443 ssl;
    server_name wotanime.my.id;
    ssl_certificate /etc/nginx/ssl/selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/selfsigned.key;
    location / {
        proxy_pass http://animest;
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
with sftp.file('/tmp/rara-nginx-ssl.conf', 'w') as f:
    f.write(nginx_config)
sftp.close()

# Apply config + reload nginx
stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/rara-nginx-ssl.conf kali:/etc/nginx/conf.d/rara-nginx.conf; "
    "docker exec kali nginx -t 2>&1; "
    "docker exec kali nginx -s reload 2>&1; "
    "sleep 3; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(80|443)' | head -5; "
    "echo; echo '=== HTTP port 80 tests ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" http://127.0.0.1:80/ 2>/dev/null); "
    "  echo \"  $D HTTP → $CODE\"; "
    "done; "
    "echo; echo '=== HTTPS port 443 tests (self-signed) ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 -H \"Host: $D\" https://127.0.0.1:443/ 2>/dev/null); "
    "  echo \"  $D HTTPS → $CODE\"; "
    "done; "
    "echo; echo '=== External Cloudflare tests ==='; "
    "for D in rara.ai.id storage.kangwifi.eu.org game.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → $CODE\"; "
    "done",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
