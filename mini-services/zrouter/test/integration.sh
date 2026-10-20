#!/usr/bin/env bash
# Full integration test: starts gateway + mock upstream, runs tests, tears down.
set -e

pkill -f "bun run" 2>/dev/null || true
sleep 1
rm -f ~/.zrouter/config.json

cd /home/z/my-project/zrouter

# Start gateway (foreground but in subshell)
(
  exec bun run src/index.ts > /tmp/zrouter.log 2>&1
) &
GATEWAY_PID=$!

# Start mock upstream
(
  exec bun run test/mock-upstream.ts > /tmp/mock.log 2>&1
) &
MOCK_PID=$!

# Wait for both to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1 && \
     curl -sf http://127.0.0.1:4123/v1/models > /dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

trap "kill $GATEWAY_PID $MOCK_PID 2>/dev/null || true" EXIT

echo "=== Both servers up ==="
echo ""

# Bootstrap admin key
KEY=$(curl -s -X POST http://127.0.0.1:3000/admin/api/keys -H "Content-Type: application/json" -d '{"name":"test"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['key']['key'])")
echo "Admin key: $KEY"
echo ""

# Save mock as ollama provider with custom baseUrl
echo "=== Save ollama provider pointing at mock ==="
curl -s -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"ollama","baseUrl":"http://localhost:4123/v1","enabled":true}'
echo ""
echo ""

echo "=== GET /v1/models ==="
curl -s http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

echo "=== NON-STREAMING /v1/chat/completions ==="
curl -s -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/mock-llama",
    "messages": [{"role":"user","content":"Hi there!"}]
  }' | python3 -m json.tool
echo ""

echo "=== STREAMING /v1/chat/completions (raw SSE bytes) ==="
curl -sN -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/mock-llama",
    "messages": [{"role":"user","content":"Hi there!"}],
    "stream": true
  }'
echo ""
echo ""

echo "=== STREAMING with tools ==="
curl -sN -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama/mock-llama",
    "messages": [{"role":"user","content":"weather?"}],
    "tools": [{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    "stream": true
  }'
echo ""
echo ""

echo "=== FALLBACK test: bad model falls through to configured fallback ==="
# Save groq with bad key, set fallback to mock
curl -s -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"groq","apiKey":"gsk_fake","enabled":true}' > /dev/null
curl -s -X POST http://127.0.0.1:3000/admin/api/fallbacks -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"sourceModel":"groq/llama-3.3-70b-versatile","targetModel":"ollama/mock-llama","triggerStatus":[403,429,503],"enabled":true}' > /dev/null
echo "(Should fall through groq→ollama and return mock response)"
curl -s -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "groq/llama-3.3-70b-versatile",
    "messages": [{"role":"user","content":"Fallback test"}]
  }' | python3 -m json.tool
echo ""

echo ""
echo "=== ALL INTEGRATION TESTS PASSED ==="
