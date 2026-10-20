#!/bin/bash
set -e
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"

echo "─── 1. POST /api/auth (empty body, browser UA) ───"
RESP=$(curl -sS -X POST http://127.0.0.1:3002/api/auth \
    -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{}' \
    --max-time 10)
echo "$RESP"
TOKEN=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || echo "")
echo "TOKEN_LEN=${#TOKEN}"

echo ""
echo "─── 2. GET /api/auth (validate token works) ───"
curl -sS http://127.0.0.1:3002/api/auth \
    -H "Authorization: Bearer $TOKEN" \
    -H "User-Agent: $UA" \
    --max-time 10
echo ""

echo ""
echo "─── 3. POST /api/admin/login (wrong password → should 401) ───"
curl -sS -X POST http://127.0.0.1:3002/api/admin/login \
    -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{"username":"admin","password":"wrong-password"}' \
    --max-time 10
echo ""

echo ""
echo "─── 4. POST /api/admin/login (correct creds → should return adminKey) ───"
ADMIN_RESP=$(curl -sS -X POST http://127.0.0.1:3002/api/admin/login \
    -H "Content-Type: application/json" \
    -H "User-Agent: $UA" \
    -d '{"username":"admin","password":"zHTQTNNh8sso9Fo/Pq+h1Xma"}' \
    --max-time 10)
echo "$ADMIN_RESP"
ADMIN_KEY=$(echo "$ADMIN_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("adminKey",""))' 2>/dev/null || echo "")
echo "ADMIN_KEY_LEN=${#ADMIN_KEY}"

echo ""
echo "─── 5. GET /api/admin/users (with admin key from login) ───"
curl -sS http://127.0.0.1:3002/api/admin/users \
    -H "User-Agent: $UA" \
    -H "X-Admin-Key: $ADMIN_KEY" \
    --max-time 10
echo ""

echo ""
echo "─── 6. GET /admin (HTML page — should show username/password form, not 'Admin Key' label) ───"
HTML=$(curl -sS http://127.0.0.1:3002/admin \
    -H "User-Agent: $UA" \
    --max-time 10)
# Check for the new Username field label + the absence of the old "Admin Key" label
if echo "$HTML" | grep -q "Username"; then
    echo "  ✓ /admin HTML contains 'Username' field label"
else
    echo "  ✗ /admin HTML does NOT contain 'Username' field label"
fi
if echo "$HTML" | grep -qE 'placeholder="64-char hex key"'; then
    echo "  ✗ /admin HTML still has old '64-char hex key' placeholder"
else
    echo "  ✓ old '64-char hex key' placeholder is gone"
fi
if echo "$HTML" | grep -q "Masuk Admin"; then
    echo "  ✓ 'Masuk Admin' button present"
fi

echo ""
echo "─── 7. External probe: https://rara.ai.id/ ───"
curl -sk -o /dev/null -w 'http=%{http_code} size=%{size_download}\n' \
    -H "User-Agent: $UA" \
    https://rara.ai.id/
