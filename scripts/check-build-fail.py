#!/usr/bin/env python3
"""Check GH Actions build failure logs."""
import base64, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

# Get the failed run details
req = urllib.request.Request(
    "https://api.github.com/repos/Yz776/kali-linux/actions/runs?per_page=1",
    headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"},
)
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.loads(resp.read().decode())
    run = data["workflow_runs"][0]
    run_id = run["id"]
    print(f"Run #{run['run_number']}: {run['status']}/{run.get('conclusion')}")
    print(f"URL: {run['html_url']}")

# Get the job ID
req2 = urllib.request.Request(
    f"https://api.github.com/repos/Yz776/kali-linux/actions/runs/{run_id}/jobs",
    headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"},
)
with urllib.request.urlopen(req2, timeout=15) as resp:
    data = json.loads(resp.read().decode())
    for job in data.get("jobs", []):
        job_id = job["id"]
        print(f"\nJob: {job['name']} -> {job['status']}/{job.get('conclusion')}")
        for step in job.get("steps", []):
            if step.get("conclusion") == "failure":
                print(f"  FAILED step: {step['name']}")

# Download the logs
req3 = urllib.request.Request(
    f"https://api.github.com/repos/Yz776/kali-linux/actions/jobs/{job_id}/logs",
    headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"},
)
try:
    with urllib.request.urlopen(req3, timeout=30) as resp:
        logs = resp.read().decode("utf-8", errors="replace")
        # Find error lines
        for line in logs.split("\n"):
            if any(kw in line.lower() for kw in ["error", "failed", "not found", "cannot", "fatal"]):
                print(f"  LOG: {line.strip()[:200]}")
except Exception as e:
    print(f"Could not fetch logs: {e}")

# Also check: does the image have bun installed?
import paramiko
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)
stdin, stdout, stderr = client.exec_command(
    "echo '=== bun in current image ==='; "
    "docker run --rm --entrypoint which ghcr.io/yz776/kali-linux:main bun 2>&1; "
    "echo; echo '=== bun version ==='; "
    "docker run --rm --entrypoint bun ghcr.io/yz776/kali-linux:main --version 2>&1; "
    "echo; echo '=== check /data/apps/rara-agent exists in image ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /data/apps/ 2>&1 | head -5; "
    "echo; echo '=== check run-rara-*.sh exist ==='; "
    "docker run --rm --entrypoint ls ghcr.io/yz776/kali-linux:main -la /usr/local/bin/run-rara-*.sh 2>&1",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
