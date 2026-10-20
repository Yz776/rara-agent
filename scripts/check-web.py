#!/usr/bin/env python3
"""Check all web services status on 209.50.50.121."""
import paramiko, base64

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname="209.50.50.121", username="root", password="REDACTED_WIFI_PASS",
               timeout=15, allow_agent=False, look_for_keys=False)

stdin, stdout, stderr = client.exec_command(
    "echo '=== Container status ==='; "
    "docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'; "
    "echo; echo '=== PM2 apps ==='; "
    "docker exec kali pm2 list 2>&1 | head -25; "
    "echo; echo '=== Listening ports ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3003|3051|47291|8090|8881)' | head -15; "
    "echo; echo '=== HTTP tests ==='; "
    "for URL in http://localhost:3002 http://localhost:3001 http://localhost:8090 http://localhost:47291 http://localhost:3000 http://localhost:80 http://localhost:443 http://localhost:8881; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 $URL 2>/dev/null); "
    "  echo \"  $URL → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== Docker logs (last 20, filtered) ==='; "
    "docker logs kali 2>&1 | grep -vE 'failed to kill|process tree killed' | tail -20",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()
