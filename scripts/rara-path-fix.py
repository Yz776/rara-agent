#!/usr/bin/env python3
"""
Quick fix: add 'export PATH' to run scripts so bun is found.
Also check if /opt/rara-agent exists in the image.
"""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Check if /opt/rara-agent exists in the image + where bun is
stdin, stdout, stderr = client.exec_command(
    "echo '=== /opt/rara-agent in image ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /opt/rara-agent/ 2>&1 | head -10; "
    "echo; echo '=== bun location ==='; "
    "docker run --rm --entrypoint which ghcr.io/yz776/kali-linux:main bun 2>&1; "
    "echo; echo '=== PATH in image ==='; "
    "docker run --rm --entrypoint bash ghcr.io/yz776/kali-linux:main -c 'echo $PATH' 2>&1; "
    "echo; echo '=== check if start-all.sh sets PATH ==='; "
    "docker run --rm --entrypoint grep ghcr.io/yz776/kali-linux:main -E 'PATH|export' /usr/local/bin/start-all.sh 2>&1 | head -10",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Also fix the run scripts on the running container — add PATH export
print("\n=== Fixing run scripts on running container ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    # Add PATH export to the run scripts (sed insert after #!/usr/bin/env bash)
    "docker exec kali sed -i '2iexport PATH=\"/data/root/.bun/bin:/data/root/.local/bin:$PATH\"' /usr/local/bin/run-rara-web.sh; "
    "docker exec kali sed -i '2iexport PATH=\"/data/root/.bun/bin:/data/root/.local/bin:$PATH\"' /usr/local/bin/run-rara-zrouter.sh; "
    "echo 'fixed run scripts'; "
    # Verify
    "docker exec kali head -5 /usr/local/bin/run-rara-web.sh 2>&1; "
    "echo; echo '=== restart rara-web + rara-zrouter ==='; "
    "docker exec kali pm2 restart rara-web rara-zrouter 2>&1 | head -5; "
    "sleep 15; "
    "echo; echo '=== PM2 status after restart ==='; "
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
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
