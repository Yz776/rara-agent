#!/usr/bin/env python3
"""
Deploy Hiura VTuber character to server:
1. Upload 6 expression images (idle, happy, thinking, talking, shy, surprised)
2. Upload new Rara3D.tsx component (image-based VTuber with mood switching)
3. Rebuild Next.js + restart
4. Push to rara-agent repo
5. Test
"""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  Deploy Hiura VTuber Character to Rara AI", flush=True)
print("=" * 70, flush=True)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# ═══ Step 1: Upload Hiura expression images + Rara3D component ═══
print("\n[1/5] Upload Hiura images + Rara3D component...", flush=True)

# Create hiura dir in container
stdin, stdout, stderr = client.exec_command(
    "docker exec kali mkdir -p /opt/rara-agent/public/hiura",
    timeout=10
)
stdout.read()

# Upload 6 expression images via SFTP
sftp = client.open_sftp()

# Upload each expression image
expressions = ['idle', 'happy', 'thinking', 'talking', 'shy', 'surprised']
for expr in expressions:
    local_path = f'/home/z/my-project/download/hiura-{expr}.png'
    remote_path = f'/tmp/hiura-{expr}.png'
    sftp.put(local_path, remote_path)
    print(f"  uploaded hiura-{expr}.png", flush=True)

# Upload the new Rara3D.tsx
sftp.put('/home/z/my-project/src/components/Rara3D.tsx', '/tmp/new-rara3d-vtuber.tsx')
print("  uploaded Rara3D.tsx", flush=True)

sftp.close()

# Copy images + component into container
stdin, stdout, stderr = client.exec_command(
    "for E in idle happy thinking talking shy surprised; do "
    f"  docker cp /tmp/hiura-$E.png kali:/opt/rara-agent/public/hiura/hiura-$E.png; "
    "done && "
    "docker cp /tmp/new-rara3d-vtuber.tsx kali:/opt/rara-agent/src/components/Rara3D.tsx && "
    "echo 'all files copied to container'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Verify images exist
stdin, stdout, stderr = client.exec_command(
    "docker exec kali ls -la /opt/rara-agent/public/hiura/ 2>&1",
    timeout=10
)
print(stdout.read().decode("utf-8", errors="replace"))

# ═══ Step 2: Rebuild Next.js ═════════════════════════════════════
print("\n[2/5] Rebuild Next.js...", flush=True)
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

# ═══ Step 3: Restart rara-web + test ═════════════════════════════
print("\n[3/5] Restart + test...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart rara-web --update-env 2>&1 | head -3; "
    "sleep 10; "
    "echo; echo '=== rara.ai.id ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://rara.ai.id/ 2>&1; "
    "echo; echo '=== hiura images accessible? ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3002/hiura/idle.png 2>&1; "
    "echo; echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id dl.kangwifi.eu.org; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); echo \"  $D → $CODE\"; done",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))

# ═══ Step 4: Push to rara-agent repo ═════════════════════════════
print("\n[4/5] Push to rara-agent repo...", flush=True)
cmd = (
    "rm -rf /tmp/rara-push && mkdir -p /tmp/rara-push && cd /tmp/rara-push && "
    "git clone --depth 1 https://x-access-token:" + PAT + "@github.com/Yz776/rara-agent.git 2>&1 | tail -2 && "
    "cd rara-agent && "
    # Copy Rara3D.tsx from container
    "docker cp kali:/opt/rara-agent/src/components/Rara3D.tsx src/components/Rara3D.tsx && "
    # Copy hiura images from container
    "mkdir -p public/hiura && "
    "for E in idle happy thinking talking shy surprised; do "
    "  docker cp kali:/opt/rara-agent/public/hiura/hiura-$E.png public/hiura/hiura-$E.png; "
    "done && "
    "echo; git diff --stat; "
    "echo; git add -A && "
    "git commit -m 'feat: Hiura VTuber character with 6 expressions + mood-reactive animations' 2>&1 | tail -3; "
    "git push https://x-access-token:" + PAT + "@github.com/Yz776/rara-agent.git main 2>&1 | tail -3; "
    "cd /tmp && rm -rf rara-push; "
    "echo 'PUSH_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
out = stdout.read().decode("utf-8", errors="replace")
print(out)

# ═══ Step 5: Save PM2 ═══════════════════════════════════════════
print("\n[5/5] Save PM2...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

client.close()

print("\n" + "=" * 70, flush=True)
print("  HIURA VTUBER DEPLOYED", flush=True)
print("=" * 70, flush=True)
