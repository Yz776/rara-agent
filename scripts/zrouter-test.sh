#!/usr/bin/env bash
# Run the zrouter server + execute a batch of curl tests, all in one
# bash session so the server stays alive for the whole test batch.
# Usage: bash /home/z/my-project/scripts/zrouter-test.sh [start|tests|stop]
set -u

REPO=/home/z/my-project/zrouter
DATA_DIR=/tmp/krouter-test
LOG=/tmp/krouter.log
PIDFILE=/tmp/krouter.pid
PORT=3777

cmd="${1:-tests}"

start_server() {
  pkill -f 'bun run src/index.ts' 2>/dev/null
  sleep 1
  rm -rf "$DATA_DIR"
  mkdir -p "$DATA_DIR"
  if [ -f "$REPO/.env" ] && [ ! -f "$REPO/.env.bak" ]; then
    mv "$REPO/.env" "$REPO/.env.bak"
  fi
  nohup setsid env -i HOME=/home/z PATH=/usr/local/bin:/usr/bin:/bin \
    KROUTER_DATA_DIR="$DATA_DIR" PORT=$PORT HOST=127.0.0.1 \
    bun run "$REPO/src/index.ts" > "$LOG" 2>&1 < /dev/null &
  disown
  echo $! > "$PIDFILE"
  echo "spawned PID $(cat $PIDFILE)"
  sleep 4
  if ps -p "$(cat $PIDFILE)" > /dev/null; then echo "✓ alive"; else echo "✗ DEAD"; tail -30 "$LOG"; exit 1; fi
}

stop_server() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat $PIDFILE)" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  pkill -f 'bun run src/index.ts' 2>/dev/null
  if [ -f "$REPO/.env.bak" ]; then mv "$REPO/.env.bak" "$REPO/.env"; fi
  echo "stopped"
}

case "$cmd" in
  start) start_server ;;
  stop)  stop_server ;;
  tests)
    start_server
    run_curl() {
      # Use --location to follow redirects, -s for silent, -w for HTTP code
      echo
      echo "=== $1 ==="
      shift
      curl -s --location "$@"
      echo
    }
    BASE="http://127.0.0.1:$PORT"
    echo "=== 1. Bootstrap status (no admin keys, no users, no pool) ==="
    curl -s "$BASE/admin/api/status"; echo
    echo
    echo "=== 2. Anonymous /v1/models (bootstrap mode → 200 empty) ==="
    curl -s -w "\nHTTP %{http_code}\n" "$BASE/v1/models"
    echo
    echo "=== 3. Login as default admin ==="
    curl -s -c "$DATA_DIR/admin.jar" -X POST "$BASE/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"password123"}'
    echo
    echo "=== 4. Bootstrap admin API key ==="
    BOOTSTRAP_RESP=$(curl -s -b "$DATA_DIR/admin.jar" -X POST "$BASE/admin/api/keys" \
      -H 'Content-Type: application/json' -d '{"name":"bootstrap"}')
    echo "$BOOTSTRAP_RESP"
    ADMIN_KEY=$(echo "$BOOTSTRAP_RESP" | grep -oE 'kr-[a-f0-9]+' | head -1)
    echo "Extracted admin key: $ADMIN_KEY"
    echo
    echo "=== 5. Create alice (role=user) ==="
    curl -s -b "$DATA_DIR/admin.jar" -X POST "$BASE/api/auth/users" \
      -H 'Content-Type: application/json' \
      -d '{"username":"alice","password":"alicepass","role":"user"}'
    echo
    echo "=== 6. Alice login ==="
    curl -s -c "$DATA_DIR/alice.jar" -X POST "$BASE/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"username":"alice","password":"alicepass"}'
    echo
    echo
    echo "=== 7. Alice /admin/api/keys → expect 403 ==="
    curl -s -b "$DATA_DIR/alice.jar" -w "\nHTTP %{http_code}\n" "$BASE/admin/api/keys"
    echo
    echo "=== 8. Alice /admin/api/pool → expect 403 ==="
    curl -s -b "$DATA_DIR/alice.jar" -w "\nHTTP %{http_code}\n" "$BASE/admin/api/pool"
    echo
    echo "=== 9. Admin API key as Bearer → expect 200 ==="
    curl -s -H "Authorization: Bearer $ADMIN_KEY" "$BASE/admin/api/pool/stats"
    echo
    echo "=== 10. Admin API key as x-api-key → expect 200 ==="
    curl -s -H "x-api-key: $ADMIN_KEY" "$BASE/admin/api/keys"
    echo
    echo "=== 11. Admin enables public access (models=all) ==="
    curl -s -b "$DATA_DIR/admin.jar" -X POST "$BASE/admin/api/public-access" \
      -H 'Content-Type: application/json' \
      -d '{"enabled":true,"requestsPerHour":100,"models":"all"}'
    echo
    echo "=== 12. Add 2 pool entries for openai ==="
    curl -s -b "$DATA_DIR/admin.jar" -X POST "$BASE/admin/api/pool" \
      -H 'Content-Type: application/json' \
      -d '{"label":"key-1","providerId":"openai","apiKey":"sk-test-AAAA"}'
    echo
    curl -s -b "$DATA_DIR/admin.jar" -X POST "$BASE/admin/api/pool" \
      -H 'Content-Type: application/json' \
      -d '{"label":"key-2","providerId":"openai","apiKey":"sk-test-BBBB"}'
    echo
    echo "=== 13. Pool stats ==="
    curl -s -b "$DATA_DIR/admin.jar" "$BASE/admin/api/pool/stats"
    echo
    echo "=== 14. Pool entries list ==="
    curl -s -b "$DATA_DIR/admin.jar" "$BASE/admin/api/pool"
    echo
    echo "=== 15. Anonymous /v1/models after public access (expect 200, empty list since openai key is fake) ==="
    curl -s -w "\nHTTP %{http_code}\n" "$BASE/v1/models"
    echo
    echo "=== 16. Anonymous POST /v1/chat/completions (will fail at upstream, but should be authorized) ==="
    curl -s -X POST "$BASE/v1/chat/completions" \
      -H 'Content-Type: application/json' \
      -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":false}' | head -c 400
    echo
    echo
    echo "=== 17. Disable public access — anonymous now 401 ==="
    curl -s -b "$DATA_DIR/admin.jar" -X POST "$BASE/admin/api/public-access" \
      -H 'Content-Type: application/json' -d '{"enabled":false}' > /dev/null
    curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/v1/chat/completions" \
      -H 'Content-Type: application/json' \
      -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":false}'
    echo
    echo "=== 18. Patch pool entry (toggle enabled) ==="
    POOL_ID=$(curl -s -b "$DATA_DIR/admin.jar" "$BASE/admin/api/pool?providerId=openai" | grep -oE '"id":"[a-f0-9-]+"' | head -1 | sed 's/"id":"//;s/"//')
    echo "Patching entry $POOL_ID"
    curl -s -b "$DATA_DIR/admin.jar" -X PATCH "$BASE/admin/api/pool/$POOL_ID" \
      -H 'Content-Type: application/json' \
      -d '{"enabled":false}'
    echo
    echo "=== 19. Delete the other pool entry ==="
    POOL_ID2=$(curl -s -b "$DATA_DIR/admin.jar" "$BASE/admin/api/pool?providerId=openai" | grep -oE '"id":"[a-f0-9-]+"' | head -1 | sed 's/"id":"//;s/"//')
    echo "Deleting $POOL_ID2"
    curl -s -b "$DATA_DIR/admin.jar" -X DELETE "$BASE/admin/api/pool/$POOL_ID2"
    echo
    echo "=== 20. Pool stats after changes ==="
    curl -s -b "$DATA_DIR/admin.jar" "$BASE/admin/api/pool/stats"
    echo
    echo "=== 21. /admin/api/status (after all changes) ==="
    curl -s "$BASE/admin/api/status"
    echo
    echo "=== 22. Server log tail (any errors) ==="
    tail -15 "$LOG"
    stop_server
    ;;
  *) echo "Usage: $0 [start|tests|stop]"; exit 1 ;;
esac
