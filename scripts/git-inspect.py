#!/usr/bin/env python3
"""Check git state on the server — is there a cached PAT or SSH key we can use to push?"""

import os
import sys
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

if not PASS:
    sys.exit(2)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)


def run(cmd: str, timeout: int = 60) -> None:
    print(f"$ {cmd[:200]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.rstrip()[:2000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:600]}")
    if code != 0:
        print(f"[exit={code}]")
    print()


# Check git state inside the container
print("─── 1. rara-agent git status (server) ───")
run("docker exec kali sh -c 'cd /opt/rara-agent && git remote -v'")
run("docker exec kali sh -c 'cd /opt/rara-agent && git status -s | head -30'")
run("docker exec kali sh -c 'cd /opt/rara-agent && git log --oneline -3'")
run("docker exec kali sh -c 'cd /opt/rara-agent && git config --get credential.helper || echo \"no helper\"'")

# Check if there's a ~/.git-credentials or ~/.netrc
print("─── 2. Cached credentials on server ───")
run("docker exec kali sh -c 'ls -la ~/.git-credentials 2>&1; ls -la ~/.netrc 2>&1; ls -la /root/.ssh/ 2>&1'")

# Check git config user
print("─── 3. Git user config ───")
run("docker exec kali sh -c 'cd /opt/rara-agent && git config user.name; git config user.email'")

# Check kali-linux repo state — it's probably on the host filesystem
print("─── 4. kali-linux repo state ───")
run("docker exec kali sh -c 'ls /opt/kali-linux 2>&1; ls -la /root/kali-linux 2>&1; find / -maxdepth 4 -name Dockerfile -path \"*kali*\" 2>/dev/null | head -5'")

# Check if the host has a kali-linux clone
print("─── 5. Host-level kali-linux clone ───")
run("ls -la /root/kali-linux 2>&1; ls -la /opt/kali-linux 2>&1; find / -maxdepth 4 -name Dockerfile -path '*kali*' 2>/dev/null | head -5")

client.close()
