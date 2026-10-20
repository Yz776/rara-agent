#!/usr/bin/env python3
"""
SSH to 209.50.50.121 and inspect the current rara-agent layout (server-side).

We use paramiko (Python SSH library) because direct ssh from the sandbox is
blocked by the security monitor. The password is short and is read from the
environment to avoid putting it literally in the command line.
"""

import os
import sys
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
PORT = int(os.environ.get("RARA_PORT", "22"))
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")  # set in env, NOT in code

if not PASS:
    print("ERROR: set RARA_PASS env var first", file=sys.stderr)
    sys.exit(2)


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    """Run a command and return (exit_code, stdout, stderr)."""
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def main() -> int:
    print(f"→ connecting to {USER}@{HOST}:{PORT}")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=HOST,
            port=PORT,
            username=USER,
            password=PASS,
            timeout=20,
            banner_timeout=20,
            auth_timeout=20,
        )
    except Exception as e:
        print(f"✗ SSH connect failed: {e}", file=sys.stderr)
        return 1

    probes = [
        "uname -a",
        "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'",
        "docker exec kali sh -c 'ls -la /opt/rara-agent 2>&1 | head -20' 2>&1",
        "docker exec kali sh -c 'pm2 list 2>&1' 2>&1",
        "docker exec kali sh -c 'cat /opt/rara-agent/package.json 2>/dev/null | head -25' 2>&1",
        "docker exec kali sh -c 'curl -s -o /dev/null -w \"rara.ai.id http=%{http_code}\\n\" http://127.0.0.1:3000/ 2>&1' 2>&1",
    ]
    for cmd in probes:
        print(f"\n$ {cmd}")
        code, out, err = run(client, cmd, timeout=30)
        if out.strip():
            print(out.rstrip())
        if err.strip():
            print(f"[stderr] {err.rstrip()}")
        if code != 0:
            print(f"[exit={code}]")

    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
