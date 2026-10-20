#!/usr/bin/env python3
"""Poll for the latest kali-linux workflow run, wait until it completes."""

import os
import sys
import time
import requests

PAT = os.environ.get("GH_PAT", "").strip()
if not PAT:
    sys.exit(2)

OWNER = "Yz776"
REPO = "kali-linux"

headers = {
    "Authorization": f"Bearer {PAT}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

print(f"→ polling {OWNER}/{REPO} for new workflow run")
deadline = time.time() + 35 * 60
last_seen_id = None
last_key = None

# First, get the latest run ID before our push (so we can detect a NEW run)
try:
    r = requests.get(
        f"https://api.github.com/repos/{OWNER}/{REPO}/actions/runs?per_page=1",
        headers=headers,
        timeout=20,
    )
    initial = r.json().get("workflow_runs", [])
    if initial:
        last_seen_id = initial[0]["id"]
        print(f"  baseline run ID: {last_seen_id} (status={initial[0]['status']}/{initial[0].get('conclusion')})")
except Exception as e:
    print(f"  ! initial probe failed: {e}")

new_run_detected = False
while time.time() < deadline:
    try:
        r = requests.get(
            f"https://api.github.com/repos/{OWNER}/{REPO}/actions/runs?per_page=5",
            headers=headers,
            timeout=20,
        )
        if r.status_code != 200:
            print(f"  ! API {r.status_code}")
            time.sleep(15)
            continue
        runs = r.json().get("workflow_runs", [])
        if not runs:
            time.sleep(15)
            continue
        # Find runs that are NEWER than the baseline
        new_runs = [r for r in runs if last_seen_id is None or r["id"] > last_seen_id]
        if not new_runs:
            time.sleep(15)
            continue
        # Pick the most recent new run
        run = new_runs[0]
        if not new_run_detected:
            print(f"  ✓ new run detected: #{run['run_number']} ({run['name']})")
            print(f"    {run['html_url']}")
            new_run_detected = True
        key = (run["id"], run["status"], run.get("conclusion"))
        if key != last_key:
            print(f"    status={run['status']} conclusion={run.get('conclusion')}")
            last_key = key
        if run["status"] == "completed":
            if run["conclusion"] == "success":
                print(f"\n✓ workflow succeeded")
                sys.exit(0)
            else:
                print(f"\n✗ workflow failed: {run['conclusion']}")
                print(f"  → {run['html_url']}")
                sys.exit(1)
        time.sleep(20)
    except Exception as e:
        print(f"  ! error: {e}")
        time.sleep(15)

print(f"\n✗ timeout after 35min")
sys.exit(2)
