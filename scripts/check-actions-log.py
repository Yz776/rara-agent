#!/usr/bin/env python3
"""Fetch the failed workflow run logs to see what went wrong."""

import os
import sys
import requests
import zipfile
import io

PAT = os.environ.get("GH_PAT", "").strip()
if not PAT:
    sys.exit(2)

OWNER = "Yz776"
REPO = "kali-linux"
RUN_ID = "39431409229"

headers = {
    "Authorization": f"Bearer {PAT}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# Get the run summary
r = requests.get(
    f"https://api.github.com/repos/{OWNER}/{REPO}/actions/runs/{RUN_ID}",
    headers=headers,
    timeout=30,
)
run = r.json()
print(f"Run #{run['run_number']}: {run['name']}")
print(f"Status: {run['status']} / {run['conclusion']}")
print(f"Event: {run['event']}")
print(f"Head branch: {run['head_branch']} @ {run['head_sha'][:7]}")
print(f"URL: {run['html_url']}")
print()

# List jobs
r = requests.get(
    f"https://api.github.com/repos/{OWNER}/{REPO}/actions/runs/{RUN_ID}/jobs",
    headers=headers,
    timeout=30,
)
jobs = r.json().get("jobs", [])
print(f"Jobs ({len(jobs)}):")
for job in jobs:
    print(f"  • {job['name']} [{job['status']}/{job['conclusion']}] — {job['html_url']}")
    for step in job.get("steps", []):
        marker = "✓" if step["conclusion"] == "success" else ("✗" if step["conclusion"] == "failure" else "•")
        print(f"      {marker} {step['name']}")
print()

# Get logs (zip)
print("Fetching logs (zip)…")
r = requests.get(
    f"https://api.github.com/repos/{OWNER}/{REPO}/actions/runs/{RUN_ID}/logs",
    headers=headers,
    timeout=60,
)
if r.status_code != 200:
    print(f"  ! HTTP {r.status_code}: {r.text[:200]}")
    sys.exit(1)

zip_bytes = r.content
with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
    for name in z.namelist():
        if name.endswith(".txt"):
            content = z.read(name).decode("utf-8", "replace")
            # Look for the failure — find the last ~80 lines containing "error" or "fail"
            lines = content.splitlines()
            interesting = [l for l in lines if any(k in l.lower() for k in ["error", "fail", "exit code", "not found", "cannot", "killed"])]
            if interesting:
                print(f"\n── {name} (interesting lines) ──")
                for l in interesting[-30:]:
                    print(f"  {l.rstrip()[:300]}")
