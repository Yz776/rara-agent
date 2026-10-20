#!/usr/bin/env python3
"""Trigger new GH Actions build via empty commit + wait + deploy."""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  Trigger rebuild (rara-agent now public) + deploy", flush=True)
print("=" * 70, flush=True)

# Step 1: Empty commit to trigger new build
print("\n[1/4] Push empty commit to trigger rebuild...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

cmd = (
    "rm -rf /tmp/kali-build && mkdir -p /tmp/kali-build && cd /tmp/kali-build && "
    "git clone https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git 2>&1 | tail -3 && "
    "cd kali-linux && "
    "git commit --allow-empty -m 'trigger rebuild (rara-agent now public)' 2>&1 | tail -3; "
    "git push https://x-access-token:" + PAT + "@github.com/Yz776/kali-linux.git main 2>&1 | tail -3; "
    "cd /tmp && rm -rf kali-build; "
    "echo 'STEP1_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
out = stdout.read().decode("utf-8", errors="replace")
print(out)
if "STEP1_DONE" not in out:
    print("[!] Step 1 failed", flush=True)
    client.close()
    sys.exit(1)
print("[+] Step 1 complete", flush=True)
client.close()

# Step 2: Wait for build
print("\n[2/4] Wait for GH Actions build (full rebuild, ~5-10 min)...", flush=True)
for attempt in range(1, 31):
    time.sleep(20)
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/Yz776/kali-linux/actions/runs?per_page=1",
            headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            if data.get("workflow_runs"):
                run = data["workflow_runs"][0]
                s = run["status"]; c = run.get("conclusion")
                print(f"  [{attempt}/30] {s}/{c} (run #{run['run_number']})", flush=True)
                if s == "completed" and c == "success":
                    print("[+] BUILD SUCCEEDED!", flush=True)
                    break
                if s == "completed" and c == "failure":
                    print("[!] BUILD FAILED", flush=True)
                    # Get failed step
                    req2 = urllib.request.Request(
                        f"https://api.github.com/repos/Yz776/kali-linux/actions/runs/{run['id']}/jobs",
                        headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"},
                    )
                    with urllib.request.urlopen(req2, timeout=15) as resp2:
                        jobs = json.loads(resp2.read().decode())
                        for job in jobs.get("jobs", []):
                            for step in job.get("steps", []):
                                if step.get("conclusion") == "failure":
                                    print(f"  Failed step: {step['name']}")
                    sys.exit(1)
    except Exception as e:
        print(f"  [{attempt}/30] {type(e).__name__}", flush=True)
else:
    print("[!] Build timeout", flush=True)
    sys.exit(1)

# Step 3: Deploy
print("\n[3/4] Deploy single container...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

cmd = (
    "docker rm -f kali rara 2>/dev/null; "
    "docker pull ghcr.io/yz776/kali-linux:main 2>&1 | tail -5; "
    "docker run -d --name kali --restart unless-stopped --privileged --network host -h kali "
    "-v /data:/data -v /var/run/docker.sock:/var/run/docker.sock "
    "-e ROOT_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=') "
    "-e SSH_PORT=2222 -e GITHUB_TOKEN=" + PAT + " "
    "-e LAUNCHER_MODE=pm2 -e TZ=Asia/Jakarta "
    "-e KFAI_AUTH_SECRET=$(openssl rand -hex 24) "
    "-e KROUTER_INTERNAL_TOKEN=$(openssl rand -hex 32) "
    "-e KROUTER_ADMIN_USERNAME=admin "
    "-e KROUTER_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=') "
    "-e RARA_PORT=3002 -e ZROUTER_PORT=3001 "
    "ghcr.io/yz776/kali-linux:main 2>&1 | tail -3; "
    "sleep 90; echo 'STEP3_DONE'"
)
stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
print(stdout.read().decode("utf-8", errors="replace"))
print("[+] Step 3 complete", flush=True)

# Step 4: Verify
print("\n[4/4] Verify all features...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== docker ps ==='; "
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -25; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3051|47291|8090)' | head -15; "
    "echo; echo '=== rara-web (3002) ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

print("\n" + "=" * 70, flush=True)
print("  DEPLOY COMPLETE", flush=True)
print("=" * 70, flush=True)
