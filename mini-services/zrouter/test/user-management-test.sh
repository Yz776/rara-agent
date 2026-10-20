#!/usr/bin/env bash
# Dedicated test for user management: default admin bootstrap, self-registration
# disabled, admin-only user creation, delete, password change, security guards.
set -e

pkill -f "bun run" 2>/dev/null || true
sleep 1
rm -rf ~/.krouter/

cd /home/z/my-project/zrouter

bun run src/index.ts > /tmp/zrouter.log 2>&1 &
GW_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then break; fi
  sleep 0.3
done

trap "kill $GW_PID 2>/dev/null || true" EXIT

echo "=== Server up ==="
echo ""

# TEST 1: default admin auto-created on boot
echo "── TEST 1: Default admin auto-created on boot ──"
grep -q "Default admin user created" /tmp/zrouter.log && echo "✓ Default admin bootstrapped" || (echo "✗ Default admin NOT bootstrapped"; exit 1)
echo ""

# TEST 2: login as admin
echo "── TEST 2: Login as admin/password123 ──"
curl -sf -c /tmp/cookies.txt -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success') and d['user']['role'] == 'admin'
print(f'✓ Admin login OK')
"
echo ""

# TEST 3: /api/auth/me
echo "── TEST 3: /api/auth/me returns admin session ──"
curl -sf -b /tmp/cookies.txt http://127.0.0.1:3000/api/auth/me | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['authenticated'] and d['user']['role'] == 'admin'
print(f'✓ Session authenticated as {d[\"user\"][\"username\"]}')
"
echo ""

# TEST 4: list users (admin sees only admin initially)
echo "── TEST 4: List users (admin) — should be 1 user (default admin) ──"
curl -sf -b /tmp/cookies.txt http://127.0.0.1:3000/api/auth/users | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert len(d['users']) == 1, f'Expected 1 user, got {len(d[\"users\"])}'
print(f'✓ {len(d[\"users\"])} user: {d[\"users\"][0][\"username\"]} ({d[\"users\"][0][\"role\"]})')
"
echo ""

# TEST 5: admin creates new user
echo "── TEST 5: Admin creates new user 'alice' ──"
curl -sf -b /tmp/cookies.txt -X POST http://127.0.0.1:3000/api/auth/users -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"alicepass123","role":"user"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success') and d['user']['username'] == 'alice' and d['user']['role'] == 'user'
print(f'✓ alice created')
"
echo ""

# TEST 6: alice can log in
echo "── TEST 6: alice can log in ──"
curl -sf -c /tmp/cookies-alice.txt -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"alicepass123"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success') and d['user']['username'] == 'alice'
print(f'✓ alice login OK, role={d[\"user\"][\"role\"]}')
"
echo ""

# TEST 7: alice (non-admin) CANNOT create users
echo "── TEST 7: Non-admin CANNOT create users ──"
curl -s -b /tmp/cookies-alice.txt -X POST http://127.0.0.1:3000/api/auth/users -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"bobpass123"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'Admin' in d['error']
print(f'✓ alice blocked from creating users: {d[\"error\"]}')
"
echo ""

# TEST 8: alice CANNOT list users
echo "── TEST 8: Non-admin CANNOT list users ──"
curl -s -b /tmp/cookies-alice.txt http://127.0.0.1:3000/api/auth/users | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'Admin' in d['error']
print(f'✓ alice blocked from listing users: {d[\"error\"]}')
"
echo ""

# TEST 9: unauthenticated CANNOT create users
echo "── TEST 9: Unauthenticated CANNOT create users ──"
curl -s -X POST http://127.0.0.1:3000/api/auth/users -H "Content-Type: application/json" \
  -d '{"username":"hacker","password":"hackerpass123"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'Unauthorized' in d['error']
print(f'✓ Unauthenticated blocked: {d[\"error\"]}')
"
echo ""

# TEST 10: duplicate username rejected
echo "── TEST 10: Duplicate username rejected ──"
curl -s -b /tmp/cookies.txt -X POST http://127.0.0.1:3000/api/auth/users -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"anotherpass123","role":"user"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'taken' in d['error']
print(f'✓ Duplicate rejected: {d[\"error\"]}')
"
echo ""

# TEST 11: weak password rejected
echo "── TEST 11: Weak password (<6 chars) rejected ──"
curl -s -b /tmp/cookies.txt -X POST http://127.0.0.1:3000/api/auth/users -H "Content-Type: application/json" \
  -d '{"username":"weakuser","password":"123","role":"user"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'at least 6' in d['error']
print(f'✓ Weak password rejected: {d[\"error\"]}')
"
echo ""

# TEST 12: invalid username rejected
echo "── TEST 12: Invalid username (spaces/special chars) rejected ──"
curl -s -b /tmp/cookies.txt -X POST http://127.0.0.1:3000/api/auth/users -H "Content-Type: application/json" \
  -d '{"username":"a b c!","password":"validpass123","role":"user"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'Username must' in d['error']
print(f'✓ Invalid username rejected: {d[\"error\"]}')
"
echo ""

# TEST 13: delete user
echo "── TEST 13: Admin deletes user ──"
ALICE_ID=$(curl -sf -b /tmp/cookies.txt http://127.0.0.1:3000/api/auth/users | python3 -c "import sys,json; print([u for u in json.load(sys.stdin)['users'] if u['username']=='alice'][0]['id'])")
curl -sf -b /tmp/cookies.txt -X DELETE "http://127.0.0.1:3000/api/auth/users/$ALICE_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success')
print(f'✓ alice deleted')
"
echo ""

# TEST 14: cannot delete yourself
echo "── TEST 14: Admin cannot delete themselves ──"
ADMIN_ID=$(curl -sf -b /tmp/cookies.txt http://127.0.0.1:3000/api/auth/users | python3 -c "import sys,json; print([u for u in json.load(sys.stdin)['users'] if u['username']=='admin'][0]['id'])")
curl -s -b /tmp/cookies.txt -X DELETE "http://127.0.0.1:3000/api/auth/users/$ADMIN_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d and 'yourself' in d['error']
print(f'✓ Self-delete blocked: {d[\"error\"]}')
"
echo ""

# TEST 15: change password
echo "── TEST 15: Change password ──"
curl -sf -b /tmp/cookies.txt -X PUT http://127.0.0.1:3000/api/auth/password -H "Content-Type: application/json" \
  -d '{"oldPassword":"password123","newPassword":"newpass456"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success')
print(f'✓ Password changed')
"
echo ""

# TEST 16: login with new password
echo "── TEST 16: Login with new password works ──"
curl -sf -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"newpass456"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success')
print(f'✓ New password works')
"
echo ""

# TEST 17: old password no longer works
echo "── TEST 17: Old password no longer works ──"
curl -s -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'error' in d
print(f'✓ Old password rejected: {d[\"error\"]}')
"
echo ""

# TEST 18: login.html shows self-registration disabled
echo "── TEST 18: login.html shows self-registration disabled ──"
HTML=$(curl -sf http://127.0.0.1:3000/login.html)
echo "$HTML" | grep -q "self-registration disabled" && echo "✓ Footer says 'self-registration disabled'" || (echo "✗ Footer missing self-registration text"; exit 1)
echo "$HTML" | grep -q "Ask the administrator" && echo "✓ 'Ask administrator' note present" || (echo "✗ Note missing"; exit 1)
echo ""

# TEST 19: login.html does NOT link to /admin/create-user.html
echo "── TEST 19: login.html does NOT link to create-user.html ──"
COUNT=$(echo "$HTML" | grep -c "create-user.html" || true)
[ "$COUNT" = "0" ] && echo "✓ No create-user.html link" || (echo "✗ Still links to create-user.html"; exit 1)
echo ""

# TEST 20: dashboard has Users tab
echo "── TEST 20: Dashboard has Users tab in sidebar ──"
curl -sf http://127.0.0.1:3000/ | grep -q '"users", label: "Users"' && echo "✓ Users tab present in sidebar" || (echo "✗ Users tab missing"; exit 1)
echo ""

# TEST 21: logout works
echo "── TEST 21: Logout works ──"
curl -sf -b /tmp/cookies.txt -X POST http://127.0.0.1:3000/api/auth/logout | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success')
print(f'✓ Logged out')
"
echo ""

# TEST 22: after logout, session invalid
echo "── TEST 22: Session invalid after logout ──"
curl -sf -b /tmp/cookies.txt http://127.0.0.1:3000/api/auth/me | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert not d.get('authenticated')
print(f'✓ Session invalidated')
"
echo ""

echo "=========================================="
echo "=== ALL USER-MANAGEMENT TESTS PASSED ==="
echo "=========================================="
