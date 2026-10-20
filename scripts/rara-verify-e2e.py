#!/usr/bin/env python3
"""
End-to-end verification of the self-contained rara-agent.

Calls:
  1. POST /api/auth to get an anonymous JWT
  2. POST /api/chat with a tiny prompt — expect SSE stream with Rara's reply
  3. Confirm the new bundled opencode.ai client works (not zrouter).

Run AFTER rara-redeploy.py has finished.
"""

import os
import sys
import json
import time
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")

if not PASS:
    sys.exit(2)


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    print(f"$ {cmd[:200]}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out:
        # Truncate large output
        preview = out[:1500]
        if len(out) > 1500:
            preview += f"\n... [{len(out)} bytes total]"
        print(preview)
    if err.strip():
        print(f"[stderr] {err[:500]}")
    print()
    return code, out, err


def docker_exec(client: paramiko.SSHClient, cmd: str, timeout: int = 60) -> tuple[int, str, str]:
    # Wrap with docker exec kali sh -c
    escaped = cmd.replace("'", "'\\''")
    wrapped = f"docker exec kali sh -c '{escaped}'"
    return run(client, wrapped, timeout=timeout)


def main() -> int:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)

    print("→ Step 1: anonymous /api/auth (no body, just get a token)")
    code, out, _ = docker_exec(
        client,
        "curl -sS -X POST http://127.0.0.1:3002/api/auth -H 'Content-Type: application/json' -d '{}' --max-time 10",
    )
    print(f"  response: {out[:500]}")
    token = None
    try:
        j = json.loads(out)
        token = j.get("token") or (j.get("user", {}).get("token"))
    except Exception:
        pass
    if not token:
        # Try other shapes
        for line in out.splitlines():
            if "token" in line.lower():
                print(f"  found token-like line: {line}")
    if not token:
        print("  ✗ no token in /api/auth response — auth may be broken")
    else:
        print(f"  ✓ got token ({len(token)} chars): {token[:50]}...")

    print("\n→ Step 2: anonymous /api/chat with a tiny prompt")
    # Use a tiny prompt so the model returns short output fast
    payload = {
        "message": "halo rara, kamu siapa? jawab pendek aja.",
        "conversationId": None,
    }
    cmd = (
        "curl -sN -X POST http://127.0.0.1:3002/api/chat "
        "-H 'Content-Type: application/json' "
        f"-H 'Authorization: Bearer {token or ''}' "
        f"-d {json.dumps(payload)!r} --max-time 45"
    )
    code, out, _ = docker_exec(client, cmd, timeout=60)
    print(f"  chat response (first 800 chars):")
    print(out[:800])
    # Look for SSE events with content
    if "data:" in out:
        print("\n  ✓ SSE stream detected")
        # Count content events
        content_chunks = out.count('"type":"content"') + out.count('"type":"end"')
        print(f"  found ~{content_chunks} content/end events")
        if "Rara" in out or "ceria" in out.lower():
            print("  ✓ Rara's identity preserved in reply")
        if "opencode" in out.lower() and "error" in out.lower():
            print("  ✗ opencode error visible in chat stream")
    elif "error" in out.lower():
        print("  ✗ error in chat response")
    else:
        print("  ! no SSE data: prefix — chat may have returned non-stream")

    print("\n→ Step 3: pm2 logs (last 20 lines rara-web) — check for opencode errors")
    docker_exec(client, "pm2 logs rara-web --lines 20 --nostream 2>&1 | tail -25", timeout=30)

    print("\n→ Step 4: confirm no zrouter process + bundled opencode module loaded")
    docker_exec(client, "pm2 list 2>&1 | grep -E 'rara|name|id '")
    docker_exec(client, "ls -la /opt/rara-agent/src/lib/opencode/ 2>&1")
    docker_exec(client, "ls -la /opt/rara-agent/mini-services/ 2>&1 || echo 'mini-services gone ✓'")

    client.close()
    print("\n✓ verification complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
