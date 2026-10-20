#!/usr/bin/env python3
"""Wait 60s more + re-verify all apps."""
import paramiko, base64, time

PAT = base64.b64decode("REDACTED_PAT_B64").decode()

print("Waiting 60s for apps to fully start...", flush=True)
time.sleep(60)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    "echo '=== docker ps ==='; "
    "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -30; "
    "echo; echo '=== listening ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3051|47291|8090)' | head -15; "
    "echo; echo '=== rara-web (3002) ==='; "
    "curl -sI http://localhost:3002/ 2>&1 | head -3; "
    "echo; echo '=== zrouter health (3001) ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/health 2>&1 | head -3; "
    "echo; echo '=== rara-agent dir ==='; "
    "docker exec kali ls -la /data/apps/rara-agent/ 2>&1 | head -10; "
    "echo; echo '=== run-rara scripts exist ==='; "
    "docker exec kali ls -la /usr/local/bin/run-rara-*.sh 2>&1; "
    "echo; echo '=== last 20 log lines (filtered) ==='; "
    "docker logs kali 2>&1 | grep -vE 'failed to kill|process tree killed' | tail -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
