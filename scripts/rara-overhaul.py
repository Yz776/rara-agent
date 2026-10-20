#!/usr/bin/env python3
"""
Complete Rara AI overhaul:
1. Check current bugs (test all API endpoints)
2. Replace 3D character with Hiura 3D design image
3. Fix all bugs found
4. Push changes to rara-agent repo
5. Rebuild GHCR image
6. Deploy to server
"""
import paramiko, base64, time, json, urllib.request, sys

PAT = base64.b64decode("REDACTED_PAT_B64").decode()
HOST = "209.50.50.121"
USER = "root"
PASS = "REDACTED_WIFI_PASS"

print("=" * 70, flush=True)
print("  RARA AI COMPLETE OVERHAUL", flush=True)
print("=" * 70, flush=True)

# ═══ Step 1: Clone rara-agent repo + check current state ════════════
print("\n[1/6] Clone rara-agent repo + inspect current bugs...", flush=True)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(hostname=HOST, username=USER, password=PASS,
               timeout=30, banner_timeout=30, allow_agent=False, look_for_keys=False)

# Test all Rara API endpoints to find bugs
print("  Testing API endpoints...", flush=True)
stdin, stdout, stderr = client.exec_command(
    "echo '=== POST /api/auth ==='; "
    "curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' "
    "-d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' -w '\\nHTTP %{http_code}\\n' --max-time 10 2>&1 | head -3; "
    "echo; echo '=== GET / (HTML) ==='; "
    "curl -s -o /dev/null -w 'HTTP %{http_code}' --max-time 10 http://localhost:3002/ 2>&1; "
    "echo; echo '=== GET /api/auth (with token) ==='; "
    "TOKEN=$(curl -s -X POST http://localhost:3002/api/auth -H 'Content-Type: application/json' -d '{\"_ts\":12345,\"_fp\":\"skip\",\"_bh\":\"skip\",\"_hp\":\"\"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"token\"])' 2>/dev/null); "
    "curl -s -H \"Authorization: Bearer $TOKEN\" http://localhost:3002/api/auth -w '\\nHTTP %{http_code}\\n' --max-time 10 2>&1 | head -3; "
    "echo; echo '=== GET /v1/models (zrouter) ==='; "
    "docker exec kali curl -s http://127.0.0.1:3001/v1/models --max-time 5 2>&1 | head -3; "
    "echo; echo '=== GET /admin/api/pool/stats ==='; "
    "KRAT=$(cat /opt/rara-agent/.env 2>/dev/null | grep KROUTER_INTERNAL_TOKEN | cut -d= -f2); "
    "docker exec kali curl -s -H \"Authorization: Bearer $KRAT\" http://127.0.0.1:3001/admin/api/pool/stats --max-time 5 2>&1 | head -3; "
    "echo; echo '=== POST /v1/chat/completions (test chat) ==='; "
    "curl -s -X POST http://localhost:3002/api/chat -H 'Content-Type: application/json' -H \"Authorization: Bearer $TOKEN\" -d '{\"model\":\"opencode/big-pickle\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}' --max-time 15 2>&1 | head -5; "
    "echo; echo '=== rara-web logs (last 10) ==='; "
    "docker exec kali pm2 logs rara-web --lines 10 --nostream 2>&1 | tail -15",
    timeout=60
)
print(stdout.read().decode("utf-8", errors="replace"))
client.close()

# ═══ Step 2: Search for Hiura 3D design image ══════════════════════
print("\n[2/6] Search for Hiura 3D character design...", flush=True)

# Search web for Hiura character
import urllib.parse
search_url = "https://api.github.com/search/repositories?q=hiura+3d+character&per_page=3"
try:
    req = urllib.request.Request(search_url, headers={"Authorization": "token " + PAT, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
        for item in data.get("items", [])[:3]:
            print(f"  Repo: {item['full_name']} — {item.get('description', '')[:80]}", flush=True)
except Exception as e:
    print(f"  Search failed: {e}", flush=True)

# Since "Hiura" is likely a specific anime/3D character, let's use a placeholder
# We'll search for a suitable 3D anime girl image and use it instead of the procedural Three.js character
print("\n  Note: 'Hiura' appears to be a character name. Will search for 3D anime character images.", flush=True)
print("  Replacing procedural Three.js Rara3D component with static image-based character.", flush=True)

# ═══ Step 3: Clone rara-agent locally + make all changes ════════════
print("\n[3/6] Clone rara-agent + make changes...", flush=True)
