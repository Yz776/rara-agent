#!/usr/bin/env python3
"""Wait for the latest GitHub Actions workflow on Yz776/kali-linux to complete."""

import os
import sys
import time
import requests

PAT = os.environ.get("GH_PAT", "").strip()
if not PAT:
    print("set GH_PAT", file=sys.stderr)
    sys.exit(2)

REPO_USER = "Yz776"
REPO = "kali-linux"

headers = {
    "Authorization": f"Bearer {PAT}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

print(f"→ polling latest workflow run on {REPO_USER}/{REPO}")
deadline = time.time() + 25 * 60
last_key = None
while time.time() < deadline:
    try:
        r = requests.get(
            f"https://api.github.com/repos/{REPO_USER}/{REPO}/actions/runs?per_page=1",
            headers=headers,
            timeout=20,
        )
        if r.status_code != 200:
            print(f"  ! API {r.status_code}: {r.text[:200]}")
            time.sleep(20)
            continue
        runs = r.json().get("workflow_runs", [])
        if not runs:
            print("  no runs yet — waiting 20s")
            time.sleep(20)
            continue
        run = runs[0]
        key = (run["id"], run["status"], run["conclusion"])
        if key != last_key:
            print(f"  #{run['run_number']} {run['name']}: status={run['status']} conclusion={run.get('conclusion')}")
            print(f"  → {run['html_url']}")
            last_key = key
        if run["status"] == "completed":
            if run["conclusion"] == "success":
                print(f"\n✓ workflow succeeded")
                sys.exit(0)
            else:
                print(f"\n✗ workflow failed: {run['conclusion']}")
                sys.exit(1)
        time.sleep(20)
    except Exception as e:
        print(f"  ! error: {e}")
        time.sleep(15)

print(f"\n✗ timeout after 25min")
sys.exit(2)
