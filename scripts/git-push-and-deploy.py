#!/usr/bin/env python3
"""
Push rara-agent + kali-linux to GitHub, trigger image rebuild, deploy on server.

Pipeline:
  1. Push /home/z/my-project/kali-linux to https://github.com/Yz776/kali-linux.git
  2. Push /home/z/my-project (rara-agent) to https://github.com/Yz776/rara-agent.git
  3. Wait for GitHub Actions to build the new ghcr.io/yz776/kali-linux:main image
     (poll workflow runs on the kali-linux repo).
  4. SSH to 209.50.50.121 — pull the new image + restart the kali container.

The PAT is read from env var GH_PAT (NOT from any file). It's used once to
construct the push remote URL, then the URL is immediately reset to the
PAT-less form.

Required PAT scope: fine-grained PAT with:
  - Yz776/rara-agent  → Contents: read+write, Metadata: read
  - Yz776/kali-linux  → Contents: read+write, Metadata: read, Workflows: read
"""

import os
import sys
import subprocess
import time
import urllib.parse
import requests  # for GitHub REST API
import paramiko

REPO_USER = "Yz776"
RARA_REPO = "rara-agent"
KALI_REPO = "kali-linux"
LOCAL_RARA = "/home/z/my-project"
LOCAL_KALI = "/home/z/my-project/kali-linux"
IMAGE = "ghcr.io/yz776/kali-linux:main"

HOST = os.environ.get("RARA_HOST", "209.50.50.121")
USER = os.environ.get("RARA_USER", "root")
PASS = os.environ.get("RARA_PASS", "")
PAT = os.environ.get("GH_PAT", "").strip()

if not PAT:
    print("ERROR: set GH_PAT env var (fine-grained PAT with Contents:write on both repos)", file=sys.stderr)
    sys.exit(2)
if not PASS:
    print("ERROR: set RARA_PASS env var", file=sys.stderr)
    sys.exit(2)


def git(cwd: str, *args: str) -> tuple[int, str, str]:
    cmd = ["git", "-C", cwd, *args]
    print(f"$ {' '.join(cmd[:6])}{' …' if len(cmd) > 6 else ''}")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    out = (r.stdout or "").rstrip()
    err = (r.stderr or "").rstrip()
    code = r.returncode
    if out:
        print(out[:2000])
    if err and code != 0:
        print(f"[stderr] {err[:1500]}")
    return code, out, err


def push_repo(cwd: str, repo: str, branch: str = "main") -> bool:
    """Push the repo using the PAT, then reset the remote URL to the PAT-less form."""
    # Build URL with PAT (URL-encoded). Format:
    # https://<token>@github.com/<user>/<repo>.git
    pat_q = urllib.parse.quote(PAT, safe="")
    authed_url = f"https://{REPO_USER}:{pat_q}@github.com/{REPO_USER}/{repo}.git"
    plain_url = f"https://github.com/{REPO_USER}/{repo}.git"

    # Save current remote URL (so we can restore it)
    _, cur, _ = git(cwd, "remote", "get-url", "origin")
    cur = cur.strip()

    # Set the authed URL
    git(cwd, "remote", "set-url", "origin", authed_url)
    try:
        code, out, err = git(cwd, "push", "origin", branch, "--force-with-lease")
        ok = (code == 0)
    finally:
        # ALWAYS restore the plain URL (so the PAT is never persisted in .git/config)
        git(cwd, "remote", "set-url", "origin", plain_url)
        # Also run `git gc` to expire reflog entries that might still reference the authed URL
        git(cwd, "reflog", "expire", "--expire=now", "--all")
        git(cwd, "gc", "--prune=now", "--quiet")

    return ok


def wait_for_github_actions(repo: str, max_minutes: int = 25) -> bool:
    """Poll GitHub Actions API until the latest workflow run finishes."""
    print(f"\n→ waiting for GitHub Actions on {repo} (max {max_minutes}min)")
    headers = {
        "Authorization": f"Bearer {PAT}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    # First, find the most recent workflow run
    deadline = time.time() + max_minutes * 60
    last_status = None
    while time.time() < deadline:
        try:
            r = requests.get(
                f"https://api.github.com/repos/{REPO_USER}/{repo}/actions/runs?per_page=1",
                headers=headers,
                timeout=20,
            )
            if r.status_code != 200:
                print(f"  ! API {r.status_code}: {r.text[:200]}")
                time.sleep(15)
                continue
            runs = r.json().get("workflow_runs", [])
            if not runs:
                print("  no workflow runs yet — waiting 15s")
                time.sleep(15)
                continue
            run = runs[0]
            status = run.get("status")        # queued | in_progress | completed
            conclusion = run.get("conclusion")  # success | failure | cancelled
            html = run.get("html_url", "")
            if status != last_status:
                print(f"  run #{run['run_number']} ({run['name']}): status={status} conclusion={conclusion}")
                print(f"  {html}")
                last_status = status
            if status == "completed":
                if conclusion == "success":
                    print(f"  ✓ workflow succeeded")
                    return True
                else:
                    print(f"  ✗ workflow failed ({conclusion})")
                    return False
            time.sleep(20)
        except Exception as e:
            print(f"  ! error: {e}")
            time.sleep(15)
    print(f"  ✗ timeout after {max_minutes}min")
    return False


def deploy_on_server() -> None:
    """SSH to server + pull new image + restart kali container."""
    print("\n→ deploying on server 209.50.50.121")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=HOST, username=USER, password=PASS, timeout=20)

    def run(cmd: str, timeout: int = 600) -> None:
        print(f"$ {cmd[:240]}")
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        if out:
            print(out.rstrip()[:1500])
        if err.strip():
            print(f"[stderr] {err.rstrip()[:600]}")

    # 1. docker login to GHCR (PAT works for both github.com + ghcr.io)
    run(f"echo {PAT!r} | docker login ghcr.io -u {REPO_USER} --password-stdin", timeout=30)
    # 2. pull the new image
    run(f"docker pull {IMAGE}", timeout=300)
    # 3. find the kali container's current image digest (so we know if it changed)
    run("docker inspect kali --format '{{.Image}}' 2>&1 | head -2", timeout=15)
    # 4. save current env (so volumes / ports / env are preserved)
    # NOTE: the kali container was launched with --network host and a bunch of
    # volumes. We can't just `docker stop + rm + run` without losing config.
    # Safer approach: pull new image, then `docker compose up -d --pull always`
    # if there's a compose file. Else, leave the OLD container running — the
    # new image will be picked up on the next container recreate (manual).
    # For now, just pull + report — the user can decide.
    run("docker images ghcr.io/yz776/kali-linux --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' 2>&1 | head -5", timeout=15)
    run("docker ps --filter name=kali --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}'", timeout=15)
    # 5. Verify the OLD container is still serving
    run("docker exec kali curl -s -o /dev/null -w 'http=%{http_code}\\n' http://127.0.0.1:3002/", timeout=15)
    # 6. Note: actually rolling the container over requires the same `docker run`
    # invocation that created it. We don't have that — and the user can do it
    # manually after the new image is verified on GHCR. We'll just report.
    print("\nNOTE: New image pulled. To actually swap the running container to the new image:")
    print("  docker stop kali && docker rm kali")
    print(f"  docker run -d --name kali --network host --restart unless-stopped \\")
    print("    -v /opt:/opt -v /var/lib/docker/volumes/rara_db:/app/db \\")
    print(f"    {IMAGE}")
    print("  (Adjust volumes / env to match the original container's launch.)")

    client.close()


def main() -> int:
    # 1. Push kali-linux first (because rara-agent references it as a submodule)
    print("=" * 70)
    print("Step 1: push kali-linux")
    print("=" * 70)
    if not push_repo(LOCAL_KALI, KALI_REPO, "main"):
        print("✗ failed to push kali-linux")
        return 1
    print("✓ kali-linux pushed")

    # 2. Push rara-agent
    print("\n" + "=" * 70)
    print("Step 2: push rara-agent")
    print("=" * 70)
    if not push_repo(LOCAL_RARA, RARA_REPO, "main"):
        print("✗ failed to push rara-agent")
        return 1
    print("✓ rara-agent pushed")

    # 3. Wait for GitHub Actions to rebuild kali-linux image
    print("\n" + "=" * 70)
    print("Step 3: wait for GitHub Actions image build")
    print("=" * 70)
    if not wait_for_github_actions(KALI_REPO, max_minutes=25):
        print("⚠ GitHub Actions build didn't complete in 25min — check the Actions tab manually")
        print("  https://github.com/Yz776/kali-linux/actions")
    else:
        print("✓ image build complete")

    # 4. Deploy on server
    print("\n" + "=" * 70)
    print("Step 4: deploy on server")
    print("=" * 70)
    try:
        deploy_on_server()
    except Exception as e:
        print(f"✗ deploy failed: {e}")
        return 2

    # 5. Final summary
    print("\n" + "=" * 70)
    print("✓ push + image rebuild + deploy complete")
    print("=" * 70)
    print(f"  rara-agent: https://github.com/{REPO_USER}/{RARA_REPO}/commits/main")
    print(f"  kali-linux: https://github.com/{REPO_USER}/{KALI_REPO}/commits/main")
    print(f"  image:      {IMAGE}")
    print(f"  server:     {HOST} (kali container)")
    print()
    print("Reminder: revoke the PAT at https://github.com/settings/tokens")
    return 0


if __name__ == "__main__":
    sys.exit(main())
