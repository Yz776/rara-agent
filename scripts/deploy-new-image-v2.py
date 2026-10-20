#!/usr/bin/env python3
"""Restart the kali container with the new image — using proper arg list (no shell quoting)."""

import os
import sys
import time
import subprocess
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")
IMAGE = "ghcr.io/yz776/kali-linux:main"

if not PASS:
    sys.exit(2)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)


def run(cmd: str, timeout: int = 600) -> tuple[int, str, str]:
    print(f"$ {cmd[:240]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.rstrip()[:2000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:1500]}")
    if code != 0:
        print(f"[exit={code}]")
    return code, out, err


# 1. Check if kali container exists (it shouldn't — we just rm'd it)
print("─── 1. Check kali container state ───")
run("docker ps -a --filter name=kali --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}'")

# 2. Pull the image fresh (in case the partial pull earlier didn't complete)
print("\n─── 2. Pull image ───")
run(f"docker pull {IMAGE}", timeout=600)

# 3. Get list of env vars from a fresh inspect of the image (not the deleted container)
print("\n─── 3. Inspect image default env ───")
run(f"docker inspect {IMAGE} --format '{{{{range .Config.Env}}{{{{.}}}}{{println}}{{{{end}}}}'", timeout=30)

# 4. Start the container with a MINIMAL set of env vars. The image's CMD
# (start-all.sh) sets up everything else — we just need to pass the user-
# configurable secrets. Everything else (PATH, NODE_OPTIONS, etc.) should
# come from the image's Dockerfile ENV instructions.
print("\n─── 4. Start new container with minimal env ───")
# Use python on the server to construct + run the docker command, avoiding
# shell quoting issues entirely.
python_runner = r"""
import subprocess
import sys

# Minimal set of env vars — only the user-configurable secrets + paths.
# Everything else is baked into the image (via ENV instructions in the Dockerfile).
env_args = [
    "-e", "SSH_PORT=2222",
    "-e", "LAUNCHER_MODE=pm2",
    "-e", "TZ=Asia/Jakarta",
    "-e", "DATA_DIR=/data",
    "-e", "PM2_HOME=/data/root/.pm2",
    "-e", "NPM_CONFIG_CACHE=/data/root/.npm",
    "-e", "YARN_CACHE_FOLDER=/data/root/.yarn",
    "-e", "BUN_INSTALL=/data/root/.bun",
    "-e", "HOME=/root",
]

# Rara-agent secrets — read from the OLD .env file at /opt/rara-agent/.env
# (which was on the /data volume and persisted across the container rebuild).
import os
env_file = "/data/apps/rara-agent/.env"
if not os.path.exists(env_file):
    env_file = "/opt/rara-agent/.env"  # fallback

rara_env = {}
try:
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            rara_env[k.strip()] = v
    print(f"loaded {len(rara_env)} vars from {env_file}")
except FileNotFoundError:
    print(f"WARNING: {env_file} not found — rara-agent will use defaults")

# Pass through rara-agent secrets to the container
for k in ["KFAI_AUTH_SECRET", "KROUTER_ADMIN_PASSWORD", "KROUTER_ADMIN_USERNAME",
          "KF_AI_ADMIN_KEY", "DATABASE_URL", "OPENCODE_API_KEY", "RARA_BASE_URL"]:
    if k in rara_env and rara_env[k]:
        env_args += ["-e", f"{k}={rara_env[k]}"]

# Volumes — only the persistent data mount (everything else is ephemeral)
vol_args = [
    "-v", "/data:/data",
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
]

cmd = ["docker", "run", "-d",
       "--name", "kali",
       "--network", "host",
       "--restart", "unless-stopped",
       *vol_args,
       *env_args,
       "ghcr.io/yz776/kali-linux:main"]

print(f"running: {' '.join(cmd[:8])}… ({len(cmd)} args total)")
r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
print(f"exit={r.returncode}")
print(r.stdout.rstrip()[:200])
if r.stderr:
    print(f"stderr: {r.stderr.rstrip()[:500]}")
sys.exit(r.returncode)
"""

# Write the python script to /tmp on the host, then run it
sftp = client.open_sftp()
with sftp.open("/tmp/start-kali.py", "w") as f:
    f.write(python_runner)
sftp.close()

run("python3 /tmp/start-kali.py", timeout=120)

# 5. Verify
print("\n─── 5. Verify ───")
run("docker ps --filter name=kali --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}'", timeout=15)
print("\n── waiting 45s for apps to boot ──")
time.sleep(45)

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
print("\n─── 6. Check listening ports + pm2 ───")
run("docker exec kali ss -tlnp 2>&1 | grep -E ':300[0-9]' | head -5", timeout=15)
run("docker exec kali pm2 list 2>&1 | grep -E 'rara|nginx|name|id '", timeout=15)

print("\n─── 7. Probe rara-web (port 3002) ───")
run(f"docker exec kali curl -sS -o /dev/null -w 'http=%{{http_code}} size=%{{size_download}}\\n' -H 'User-Agent: {UA}' http://127.0.0.1:3002/", timeout=20)

print("\n─── 8. External probe ───")
run(f"curl -sk -o /dev/null -w 'rara.ai.id http=%{{http_code}} size=%{{size_download}}\\n' -H 'User-Agent: {UA}' https://rara.ai.id/", timeout=30)

print("\n─── 9. /api/auth (anonymous IP-based login, no device verification) ───")
run(f"docker exec kali curl -sS -X POST http://127.0.0.1:3002/api/auth -H 'Content-Type: application/json' -H 'User-Agent: {UA}' -d '{{}}' --max-time 10 | head -c 300", timeout=20)

print("\n─── 10. /admin HTML (should show Username field) ───")
run(f"docker exec kali curl -sS http://127.0.0.1:3002/admin -H 'User-Agent: {UA}' | head -c 300", timeout=20)

client.close()
print("\n✓ deploy complete")
