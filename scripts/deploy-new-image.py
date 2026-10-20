#!/usr/bin/env python3
"""
Deploy the freshly-built kali-linux image to server 209.50.50.121.

Steps:
  1. docker login ghcr.io (PAT works for both github.com + ghcr.io)
  2. docker pull ghcr.io/yz776/kali-linux:main
  3. Stop + rm the old kali container (preserving volumes)
  4. Re-run with the same env + volume mounts
  5. Wait + verify rara.ai.id + /api/admin/users + /admin page
"""

import os
import sys
import time
import paramiko

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")
PAT = os.environ.get("GH_PAT", "").strip()
IMAGE = "ghcr.io/yz776/kali-linux:main"

if not PASS:
    sys.exit(2)


def main() -> int:
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

    # ── 1. Capture the current container's env + volume mounts ────────────────
    print("─── 1. Capture current container env + mounts ───")
    _, mounts_out, _ = run("docker inspect kali --format '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} (rw={{.RW}}){{println}}{{end}}'", timeout=30)
    _, env_out, _ = run("docker inspect kali --format '{{range .Config.Env}}{{.}}{{println}}{{end}}'", timeout=30)
    _, nets_out, _ = run("docker inspect kali --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}={{$cfg.IPAddress}} mode={{$cfg.IPAMConfig.SubnetPrefix}}{{println}}{{end}}'", timeout=30)
    _, restart_out, _ = run("docker inspect kali --format 'restart={{.HostConfig.RestartPolicy.Name}}'", timeout=30)
    print(f"  mounts: {mounts_out.strip().splitlines()[:5]}")
    print(f"  env count: {len([l for l in env_out.splitlines() if l.strip()])}")
    print(f"  networks: {nets_out.strip()}")

    # ── 2. Login to GHCR (PAT works for ghcr.io too) ──────────────────────────
    print("\n─── 2. Login to ghcr.io ───")
    if PAT:
        run(f"echo {PAT!r} | docker login ghcr.io -u Yz776 --password-stdin 2>&1 | tail -5", timeout=30)
    else:
        print("  (no PAT — skipping login; image pull may fail if private)")

    # ── 3. Pull new image ─────────────────────────────────────────────────────
    print("\n─── 3. Pull new image ───")
    run(f"docker pull {IMAGE}", timeout=600)

    # Show the new image's digest
    run(f"docker images {IMAGE} --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}} {{.Size}}'", timeout=15)

    # ── 4. Reconstruct the docker run command ─────────────────────────────────
    # We don't know the original launch command, but we know the container uses
    # --network host. Let's reconstruct based on the captured mounts + env.
    # Common pattern (from inspect):
    #   - --network host
    #   - --restart unless-stopped
    #   - volumes: /opt:/opt, /data:/data (or similar)
    #   - env: PM2_SECRET_KEY, etc.

    # Build the docker run command from captured mounts + env
    print("\n─── 4. Reconstruct docker run command ───")
    mount_args = []
    for line in mounts_out.splitlines():
        line = line.strip()
        if not line:
            continue
        # Format: "bind:/opt->/opt (rw=True)" or "volume:rara_db->/app/db (rw=True)"
        parts = line.split("->", 1)
        if len(parts) != 2:
            continue
        src_part = parts[0]  # e.g. "bind:/opt" or "volume:rara_db"
        dst_part = parts[1].split(" ")[0]  # e.g. "/opt"
        # Extract the source path/name
        if ":" in src_part:
            # "bind:/opt" → source = /opt
            # "volume:rara_db" → source = rara_db
            src = src_part.split(":", 1)[1]
        else:
            src = src_part
        mount_args += ["-v", f"{src}:{dst_part}"]
        print(f"  mount: {src} → {dst_part}")

    env_args = []
    for line in env_out.splitlines():
        line = line.strip()
        if not line or line.startswith("PATH=") or line.startswith("HOSTNAME="):
            continue
        # Skip empty values
        if "=" in line:
            k, _, v = line.partition("=")
            if v:
                env_args += ["-e", f"{k}={v}"]
                # Mask secret values for display
                if any(s in k.upper() for s in ("SECRET", "PASSWORD", "TOKEN", "KEY")):
                    print(f"  env: {k}=***")
                else:
                    print(f"  env: {k}={v[:30]}")

    restart_policy = "unless-stopped"
    if restart_out.strip().startswith("restart="):
        restart_policy = restart_out.strip().split("=", 1)[1]

    new_cmd = ["docker", "run", "-d",
               "--name", "kali",
               "--network", "host",
               "--restart", restart_policy,
               *mount_args,
               *env_args,
               IMAGE]
    print(f"\n  new cmd (first 250 chars): {' '.join(new_cmd)[:250]}…")

    # ── 5. Stop + remove old container ────────────────────────────────────────
    print("\n─── 5. Stop + remove old kali container ───")
    run("docker stop kali 2>&1 || true", timeout=60)
    run("docker rm kali 2>&1 || true", timeout=30)

    # ── 6. Start new container ────────────────────────────────────────────────
    print("\n─── 6. Start new container with the new image ───")
    run(" ".join(new_cmd), timeout=120)
    run("docker ps --filter name=kali --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}'", timeout=15)

    # ── 7. Wait + verify ──────────────────────────────────────────────────────
    print("\n─── 7. Wait 30s for apps to settle ───")
    time.sleep(30)

    print("\n─── 8. Verify rara-web on port 3002 ───")
    UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
    run(f"docker exec kali curl -sS -o /dev/null -w 'http=%{{http_code}} size=%{{size_download}}\\n' -H 'User-Agent: {UA}' http://127.0.0.1:3002/", timeout=20)
    run(f"docker exec kali curl -sS http://127.0.0.1:3002/admin -H 'User-Agent: {UA}' | head -c 200", timeout=20)
    run(f"docker exec kali curl -sS -X POST http://127.0.0.1:3002/api/auth -H 'Content-Type: application/json' -H 'User-Agent: {UA}' -d '{{}}' --max-time 10 | head -c 300", timeout=20)
    run("docker exec kali pm2 list 2>&1 | grep -E 'rara|name|id '", timeout=15)
    run("docker exec kali ss -tlnp 2>&1 | grep -E ':300[0-9]'", timeout=15)

    print("\n─── 9. External probe ───")
    run(f"curl -sk -o /dev/null -w 'rara.ai.id http=%{{http_code}} size=%{{size_download}}\\n' -H 'User-Agent: {UA}' https://rara.ai.id/", timeout=20)

    client.close()
    print("\n✓ deploy complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
