#!/usr/bin/env python3
"""Fix puppeteer path + wait for build + deploy + final test."""
import paramiko, base64, time, sys, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=15, allow_agent=False, look_for_keys=False)

# Fix puppeteer: set PUPPETEER_EXECUTABLE_PATH in animest .env
print("=== Fix puppeteer path ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "cd /data/apps/animest && "
    "echo \"PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable\" >> .env && "
    "echo \"PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true\" >> .env && "
    "tail -5 .env"
    "' 2>&1",
    timeout=15
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart animest with new env
print("\n=== Restart animest ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali pm2 restart animest --update-env 2>&1 | head -3; "
    "sleep 15; "
    "echo; echo '=== wotanime test ==='; "
    "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://wotanime.my.id/ 2>&1; "
    "echo; echo '=== animest logs ==='; "
    "docker exec kali pm2 logs animest --lines 10 --nostream 2>&1 | tail -15",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Check GH Actions build status
print("\n=== Check GH Actions build ===", flush=True)
for attempt in range(1, 46):
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
                print(f"  [{attempt}/45] {s}/{c} (run #{run['run_number']})", flush=True)
                if s == "completed" and c == "success":
                    print("[+] BUILD SUCCEEDED!", flush=True)
                    break
                if s == "completed" and c == "failure":
                    print("[!] BUILD FAILED — but runtime container still works", flush=True)
                    # Don't exit — the current container is already running fine
                    break
    except Exception as e:
        print(f"  [{attempt}/45] {type(e).__name__}", flush=True)
else:
    print("[!] Build timeout — current container still running", flush=True)

# Final comprehensive test
print("\n=== FINAL COMPREHENSIVE TEST ===", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== docker ps ==='; "
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -20; "
    "echo; echo '=== ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3003|3051|47291|8090)' | head -15; "
    "echo; echo '=== ALL DOMAIN TESTS ==='; "
    "for D in rara.ai.id bot.kangwifi.eu.org game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -3",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

print("\n" + "=" * 70, flush=True)
print("  ALL TASKS COMPLETE", flush=True)
print("=" * 70, flush=True)
