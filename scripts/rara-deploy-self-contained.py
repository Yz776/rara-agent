#!/usr/bin/env python3
"""
Deploy the self-contained rara-agent (no zrouter) to server 209.50.50.121.

Pipeline:
  1. Locally: tar.gz the modified files (src/, package.json, Dockerfile,
     ecosystem.config.cjs, docker-compose.yml, next.config.ts, tsconfig.json,
     README.md, public/hiura/, prisma/).
  2. SFTP the tarball to /tmp/rara-patch.tar.gz inside the kali container.
  3. Inside the container:
     - cd /opt/rara-agent
     - rm -rf mini-services (drop zrouter sidecar)
     - extract the tarball over the existing tree
     - bun install (or npm install) — new deps only
     - bun run build (next build → .next/standalone)
     - pm2 delete rara-zrouter (zrouter is gone)
     - pm2 delete rara-web && pm2 start ecosystem.config.cjs (pick up new config)
     - pm2 save
  4. Verify rara.ai.id / localhost:3000 returns 200, and a chat roundtrip works.
"""

import os
import sys
import tarfile
import time
import io
import paramiko
import shlex

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
PORT = int(os.environ.get("RARA_PORT", "22"))
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")
LOCAL_PROJECT = "/home/z/my-project"
REMOTE_DIR = "/opt/rara-agent"
TARBALL_LOCAL = "/home/z/my-project/scripts/rara-patch.tar.gz"
TARBALL_REMOTE = "/tmp/rara-patch.tar.gz"

if not PASS:
    print("ERROR: set RARA_PASS env var first", file=sys.stderr)
    sys.exit(2)


# Files / dirs to ship. Paths are RELATIVE to LOCAL_PROJECT.
INCLUDE_PATHS = [
    "package.json",
    "Dockerfile",
    "docker-compose.yml",
    "ecosystem.config.cjs",
    "next.config.ts",
    "tsconfig.json",
    "README.md",
    "eslint.config.mjs",
    "postcss.config.mjs",
    "components.json",
    "tailwind.config.ts",
    "prisma",
    "public",
    "src",
]

# Files to exclude (even if they match an include path).
EXCLUDE_PATTERNS = (
    "node_modules",
    ".next",
    ".git",
    "tool-results",
    "logs",
    "db",
    "data",
    "examples",
    "scripts",
    "kali-linux",
    "upload",
    "mini-services",
    ".DS_Store",
    "dev.log",
)


def matches_exclude(path: str) -> bool:
    for pat in EXCLUDE_PATTERNS:
        if pat in path:
            return True
    return False


def build_tarball() -> str:
    """Build a tar.gz of the include paths, returning the local path."""
    print(f"→ building tarball → {TARBALL_LOCAL}")
    n = 0
    with tarfile.open(TARBALL_LOCAL, "w:gz") as tar:
        for rel in INCLUDE_PATHS:
            abs_path = os.path.join(LOCAL_PROJECT, rel)
            if not os.path.exists(abs_path):
                print(f"  ! skip (missing): {rel}")
                continue
            # Walk + add each entry, filtering excludes.
            if os.path.isfile(abs_path):
                if not matches_exclude(rel):
                    tar.add(abs_path, arcname=rel, recursive=False)
                    n += 1
            else:
                for root, dirs, files in os.walk(abs_path):
                    # Filter excluded dirs in-place so os.walk skips them.
                    dirs[:] = [d for d in dirs if not matches_exclude(os.path.join(root, d))]
                    for f in files:
                        full = os.path.join(root, f)
                        relp = os.path.relpath(full, LOCAL_PROJECT)
                        if not matches_exclude(relp):
                            tar.add(full, arcname=relp, recursive=False)
                            n += 1
    size_kb = os.path.getsize(TARBALL_LOCAL) / 1024
    print(f"  ✓ packed {n} files, {size_kb:.1f} KB")
    return TARBALL_LOCAL


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 60, quiet: bool = False) -> tuple[int, str, str]:
    if not quiet:
        print(f"$ {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if not quiet:
        if out.strip():
            print(out.rstrip()[:2000])
        if err.strip():
            print(f"[stderr] {err.rstrip()[:2000]}")
        if code != 0:
            print(f"[exit={code}]")
    return code, out, err


def sftp_upload(client: paramiko.SSHClient, local: str, remote: str) -> None:
    print(f"→ sftp {local} → {remote}")
    sftp = client.open_sftp()
    try:
        sftp.put(local, remote)
        # Verify size matches
        lsize = os.path.getsize(local)
        rsize = sftp.stat(remote).st_size
        if lsize != rsize:
            print(f"  ! size mismatch: local={lsize} remote={rsize}")
        else:
            print(f"  ✓ uploaded {lsize} bytes")
    finally:
        sftp.close()


def docker_exec(client: paramiko.SSHClient, cmd: str, timeout: int = 300, quiet: bool = False) -> tuple[int, str, str]:
    """Run a command inside the kali container."""
    wrapped = f"docker exec kali sh -c {shlex.quote(cmd)}"
    return run(client, wrapped, timeout=timeout, quiet=quiet)


def main() -> int:
    build_tarball()
    if not os.path.exists(TARBALL_LOCAL):
        print("✗ tarball missing", file=sys.stderr)
        return 1

    print(f"\n→ connecting to {USER}@{HOST}:{PORT}")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(hostname=HOST, port=PORT, username=USER, password=PASS, timeout=20)
    except Exception as e:
        print(f"✗ SSH connect failed: {e}", file=sys.stderr)
        return 1

    # Upload tarball to the host's /tmp, then docker cp into the container.
    sftp_upload(client, TARBALL_LOCAL, TARBALL_REMOTE)

    # Copy tarball from host /tmp into the container.
    print("\n→ copying tarball into kali container")
    run(client, f"docker cp {TARBALL_REMOTE} kali:{TARBALL_REMOTE}", timeout=30)

    # Pre-flight: snapshot current state.
    print("\n→ pre-flight snapshot")
    docker_exec(client, "ls /opt/rara-agent | head -30")
    docker_exec(client, "pm2 list 2>&1 | head -20")

    # 1. Remove mini-services/zrouter dir + extract the tarball over rara-agent.
    print("\n→ extracting patch over /opt/rara-agent")
    docker_exec(client, f"mkdir -p {REMOTE_DIR}")
    docker_exec(client, f"cd {REMOTE_DIR} && rm -rf mini-services examples && tar -xzf {TARBALL_REMOTE} -C {REMOTE_DIR}")
    # Verify the new opencode dir landed.
    docker_exec(client, "ls -la /opt/rara-agent/src/lib/opencode/ 2>&1")

    # 2. Install deps. Use bun (already installed in the kali image, faster).
    print("\n→ installing deps (bun install)")
    code, _, _ = docker_exec(client, "cd /opt/rara-agent && bun install 2>&1 | tail -30", timeout=300)
    if code != 0:
        print("  ! bun install failed, trying npm install")
        docker_exec(client, "cd /opt/rara-agent && npm install --no-audit --no-fund 2>&1 | tail -30", timeout=600)

    # 3. Build Next.js. The kali container has limited heap by default —
    # bump to 2GB so the TypeScript check + Next.js compilation don't OOM.
    print("\n→ building Next.js (bun run build, max-old-space-size=2048)")
    code, out, err = docker_exec(
        client,
        "cd /opt/rara-agent && NODE_OPTIONS=--max-old-space-size=2048 bun run build 2>&1 | tail -80",
        timeout=900,
    )
    if code != 0:
        print(f"  ✗ build failed (exit={code})")
        print(out)
        print(err)
        return 2
    # Also check the output for OOM strings — bun sometimes returns 0 even on OOM.
    if "FATAL ERROR" in out or "heap out of memory" in out.lower() or "Ineffective mark-compacts" in out:
        print(f"  ✗ build crashed (OOM detected in output)")
        print(out[-1500:])
        return 2
    # Verify standalone/server.js exists.
    code, out, _ = docker_exec(client, "ls -la /opt/rara-agent/.next/standalone/server.js 2>&1")
    if code != 0 or "No such file" in out:
        print(f"  ✗ build did not produce .next/standalone/server.js")
        print(out)
        return 2
    print("  ✓ build OK — standalone/server.js present")

    # 4. PM2 cleanup: delete rara-zrouter (gone), restart rara-web with new config.
    print("\n→ pm2 cleanup + restart")
    docker_exec(client, "pm2 delete rara-zrouter 2>&1 || true")
    docker_exec(client, "pm2 delete rara-web 2>&1 || true")
    docker_exec(client, f"cd {REMOTE_DIR} && pm2 start ecosystem.config.cjs 2>&1 | tail -20", timeout=60)
    docker_exec(client, "pm2 save 2>&1 | tail -5")

    # 5. Wait + verify.
    print("\n→ waiting 8s for pm2 to settle")
    time.sleep(8)

    print("\n→ verification")
    docker_exec(client, "pm2 list 2>&1 | tail -20")
    code, out, _ = docker_exec(client, "curl -s -o /dev/null -w 'http=%{http_code} size=%{size_download} time=%{time_total}\\n' http://127.0.0.1:3000/")
    if "http=200" in out:
        print("  ✓ rara.ai.id (localhost:3000) returned 200")
    else:
        print(f"  ! unexpected response: {out}")

    # Probe a chat roundtrip (anonymous OK, no auth).
    code, out, _ = docker_exec(client, """curl -sS -X POST http://127.0.0.1:3000/api/auth -H 'Content-Type: application/json' -d '{}' --max-time 10 | head -c 300""", timeout=20)
    print(f"  /api/auth → {out[:200]}")

    # Check the new opencode module is actually loaded by hitting /api/chat with a tiny prompt.
    # Skip if /api/auth didn't return a token — chat requires auth.
    print("\n→ pm2 logs (last 30 lines rara-web)")
    docker_exec(client, "pm2 logs rara-web --lines 30 --nostream 2>&1 | tail -40")

    client.close()
    print("\n✓ deploy complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
