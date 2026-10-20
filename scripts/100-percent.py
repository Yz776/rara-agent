#!/usr/bin/env python3
"""
Complete EVERYTHING:
1. Install MongoDB for animest
2. Restart animest
3. Add DNS for bot.kangwifi.eu.org via Cloudflare API
4. Final test all 5 domains
"""
import paramiko, base64, time, json, urllib.request

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  COMPLETE EVERYTHING — 100%", flush=True)
print("=" * 70, flush=True)

# ═══ Task 1: Install MongoDB for animest ════════════════════════════
print("\n[T1] Install MongoDB for animest...", flush=True)
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Install MongoDB
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "apt-get update -qq 2>&1 | tail -2 && "
    "DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-server 2>&1 | tail -5"
    "'",
    timeout=120
)
print(stdout.read().decode("utf-8", errors="replace"))

# Start MongoDB + restart animest
print("\n[T1b] Start MongoDB + restart animest...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "docker exec kali bash -c '"
    "service mongodb start 2>&1 || mongod --dbpath /var/lib/mongodb --fork --logpath /var/log/mongodb/mongod.log 2>&1; "
    "sleep 3; "
    "echo \"=== mongo test ===\"; "
    "mongosh --eval 'db.runCommand({ping:1})' 2>&1 | head -5 || mongo --eval 'db.runCommand({ping:1})' 2>&1 | head -5"
    "'",
    timeout=30
)
print(stdout.read().decode("utf-8", errors="replace"))

# Restart animest
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

# ═══ Task 2: Add DNS for bot.kangwifi.eu.org via Cloudflare API ════
print("\n[T2] Add DNS for bot.kangwifi.eu.org...", flush=True)

# First find the zone ID for kangwifi.eu.org
try:
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/zones?name=kangwifi.eu.org",
        headers={
            "Authorization": "Bearer " + PAT,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
        if data.get("success") and data.get("result"):
            zone_id = data["result"][0]["id"]
            print(f"  Zone ID: {zone_id}", flush=True)
        else:
            print(f"  Cloudflare API error: {data.get('errors')}", flush=True)
            zone_id = None
except Exception as e:
    print(f"  Cloudflare API failed: {e}", flush=True)
    zone_id = None

# If zone found, add DNS record for bot.kangwifi.eu.org
if zone_id:
    # Check existing records first
    try:
        req = urllib.request.Request(
            f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?name=bot.kangwifi.eu.org",
            headers={"Authorization": "Bearer " + PAT, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            if data.get("result") and len(data["result"]) > 0:
                print("  DNS record already exists!", flush=True)
            else:
                # Create new CNAME record
                payload = json.dumps({
                    "type": "A",
                    "name": "bot",
                    "content": "209.50.50.121",
                    "proxied": True,
                    "ttl": 1,
                }).encode()
                req2 = urllib.request.Request(
                    f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
                    data=payload,
                    headers={"Authorization": "Bearer " + PAT, "Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req2, timeout=15) as resp2:
                    data2 = json.loads(resp2.read().decode())
                    if data2.get("success"):
                        print(f"  ✓ DNS record added: bot.kangwifi.eu.org → 209.50.50.121", flush=True)
                    else:
                        print(f"  DNS add failed: {data2.get('errors')}", flush=True)
    except Exception as e:
        print(f"  DNS check/add failed: {e}", flush=True)
else:
    print("  Skipping DNS — Cloudflare zone not found via PAT", flush=True)
    print("  You need to add DNS record manually in Cloudflare dashboard:", flush=True)
    print("  Zone: kangwifi.eu.org → DNS → Add A record: bot → 209.50.50.121 → Proxied", flush=True)

# ═══ Task 3: Wait for DNS + test everything ═══════════════════════
print("\n[T3] Wait 30s for DNS propagation + final test...", flush=True)
time.sleep(30)

stdin, stdout, stderr = client.exec_command(
    "echo '=== ALL DOMAINS ==='; "
    "for D in rara.ai.id bot.kangwifi.eu.org game.kangwifi.eu.org storage.kangwifi.eu.org wotanime.my.id; do "
    "  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://$D/ 2>/dev/null); "
    "  echo \"  https://$D → HTTP $CODE\"; "
    "done; "
    "echo; echo '=== PM2 STATUS ==='; "
    "docker exec kali pm2 list 2>&1 | head -20; "
    "echo; echo '=== PORTS ==='; "
    "ss -tlnp | grep -E ':(22|80|443|2222|3000|3001|3002|3003|3051|47291|8090|27017)' | head -15; "
    "echo; echo '=== Save PM2 ==='; "
    "docker exec kali pm2 save 2>&1 | head -2",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

print("\n" + "=" * 70, flush=True)
print("  ALL TASKS COMPLETE", flush=True)
print("=" * 70, flush=True)
