#!/usr/bin/env python3
"""Fix: add no-cache headers for HTML responses + purge via cache-busting."""
import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Update nginx config to add no-cache headers for HTML
# This prevents Cloudflare from caching stale HTML/JS
print("=== Update nginx: add no-cache headers ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c 'cat /etc/nginx/conf.d/rara-nginx.conf'",
    timeout=15
)
current_conf = stdout.read().decode("utf-8", errors="replace")

# Add no-cache headers to the rara.ai.id server block
# Insert after 'proxy_set_header Connection "upgrade";' in the default server block
updated_conf = current_conf.replace(
    'proxy_set_header Connection "upgrade";\n    }',
    'proxy_set_header Connection "upgrade";\n'
    '        proxy_set_header Cache-Control "no-cache, no-store, must-revalidate";\n'
    '        proxy_set_header Pragma "no-cache";\n'
    '        proxy_set_header Expires "0";\n'
    '        add_header X-Content-Type-Options nosniff;\n'
    '        add_header Cache-Control "no-cache, no-store, must-revalidate" always;\n'
    '    }'
)

sftp = client.open_sftp()
with sftp.file('/tmp/nginx-nocache.conf', 'w') as f:
    f.write(updated_conf)
sftp.close()

stdin, stdout, stderr = client.exec_command(
    "docker cp /tmp/nginx-nocache.conf kali:/etc/nginx/conf.d/rara-nginx.conf && "
    "docker exec kali nginx -t 2>&1 && "
    "docker exec kali nginx -s reload 2>&1 && "
    "echo 'nginx updated with no-cache headers'",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Also rebuild Next.js to generate fresh JS bundles (new hash = cache busting)
print("\n=== Rebuild Next.js (fresh JS hashes) ===", flush=True)
stdin, stdout, stderr = client.exec_command(
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

# Restart rara-web
print("\n=== Restart + test ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== Cache headers ==='; "
    "curl -sI https://rara.ai.id/ 2>&1 | grep -i 'cache-control\\|x-nextjs-cache' | head -5; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done; "
    "echo; docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
