#!/usr/bin/env python3
"""Diagnose kali-linux container restart loop (exit 127)."""
import paramiko, base64

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

# Get container logs (filter out PM2 retry spam)
stdin, stdout, stderr = client.exec_command(
    "echo '=== container status ==='; "
    "docker inspect kali --format 'Status: {{.State.Status}}, ExitCode: {{.State.ExitCode}}, RestartCount: {{.RestartCount}}' 2>&1; "
    "echo; echo '=== last 30 log lines (filtered) ==='; "
    "docker logs kali 2>&1 | grep -vE 'failed to kill - retrying|process tree killed' | tail -30; "
    "echo; echo '=== check if bun exists in image ==='; "
    "docker run --rm --entrypoint which ghcr.io/yz776/kali-linux:main bun 2>&1 | head -3; "
    "echo; echo '=== check run-rara-*.sh scripts exist ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /usr/local/bin/run-rara-*.sh 2>&1 | head -5; "
    "echo; echo '=== check rara-agent dir exists ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /data/apps/rara-agent/ 2>&1 | head -10",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
err = stderr.read().decode("utf-8", errors="replace")
if err: print("STDERR:", err[:500])
client.close()
