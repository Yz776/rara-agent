#!/usr/bin/env bash
# Comprehensive feature test: original integration + custom providers + proxy routing.
set -e

pkill -f "bun run" 2>/dev/null || true
sleep 1
rm -rf ~/.krouter/

cd /home/z/my-project/zrouter

# Start gateway + mock
bun run src/index.ts > /tmp/zrouter.log 2>&1 &
GATEWAY_PID=$!
bun run test/mock-upstream.ts > /tmp/mock.log 2>&1 &
MOCK_PID=$!

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1 && \
     curl -sf http://127.0.0.1:4123/v1/models > /dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

trap "kill $GATEWAY_PID $MOCK_PID 2>/dev/null || true" EXIT

echo "=== Both servers up ==="

# Bootstrap admin key
KEY=$(curl -s -X POST http://127.0.0.1:3000/admin/api/keys -H "Content-Type: application/json" -d '{"name":"test"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['key']['key'])")
echo "Admin key: $KEY"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 1: Bootstrap / status ──"
curl -sf http://127.0.0.1:3000/admin/api/status | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 2: Provider list (built-in) ──"
curl -sf http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Total providers: {len(d[\"providers\"])}')"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 3: Save built-in provider (ollama → mock) ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"ollama","baseUrl":"http://localhost:4123/v1","enabled":true}'
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 4: GET /v1/models ──"
curl -sf http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 5: Non-streaming chat ──"
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/mock-llama","messages":[{"role":"user","content":"hello"}]}' | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 6: Streaming chat ──"
curl -sN -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/mock-llama","messages":[{"role":"user","content":"stream"}],"stream":true}' | head -3
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 7: Fallback (groq with bad key → fallback to mock) ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"groq","apiKey":"gsk_fake","enabled":true}' > /dev/null
curl -sf -X POST http://127.0.0.1:3000/admin/api/fallbacks -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"sourceModel":"groq/llama-3.3-70b-versatile","targetModel":"ollama/mock-llama","triggerStatus":[403,429,503],"enabled":true}' > /dev/null
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"groq/llama-3.3-70b-versatile","messages":[{"role":"user","content":"fb"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Fallback OK, content:', d['choices'][0]['message']['content'])"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 8: Embeddings ──"
curl -sf -X POST http://127.0.0.1:3000/v1/embeddings \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/mock-llama","input":"hello world"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Embeddings OK, dim:', len(d['data'][0]['embedding']))"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 9: Combos ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/combos -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"test-combo","strategy":"fallback","models":["ollama/mock-llama"]}' > /dev/null
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"combo/test-combo","messages":[{"role":"user","content":"combo"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Combo OK, content:', d['choices'][0]['message']['content'])"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 10: Virtual keys (rate-limit + quota) ──"
VK=$(curl -sf -X POST http://127.0.0.1:3000/admin/api/virtual-keys -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"test-vk","rateLimit":100,"quotaLimit":10000,"creditLimit":10,"allowedModels":["ollama/*"]}')
VK_KEY=$(echo "$VK" | python3 -c "import sys,json; print(json.load(sys.stdin)['key']['key'])")
echo "Virtual key: $VK_KEY"
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $VK_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/mock-llama","messages":[{"role":"user","content":"vk"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('VK chat OK, content:', d['choices'][0]['message']['content'])"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 11: Token saver settings GET/POST ──"
curl -sf http://127.0.0.1:3000/admin/api/token-saver -H "Authorization: Bearer $KEY" | python3 -m json.tool
curl -sf -X POST http://127.0.0.1:3000/admin/api/token-saver -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true,"compressToolOutput":{"enabled":true,"minCharacterThreshold":500},"lazySeniorDev":{"enabled":false,"mode":"balanced"},"compressLlmOutput":{"enabled":false,"mode":"terse"},"trimMessages":{"enabled":true,"maxInputTokens":32768,"preserveTailMessages":4}}' \
  | python3 -c "import sys,json; print('Token saver saved:', json.load(sys.stdin))"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 12: Logs ──"
curl -sf http://127.0.0.1:3000/admin/api/logs -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Logs: {len(d[\"logs\"])} entries')"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 13: Usage summary ──"
curl -sf http://127.0.0.1:3000/admin/api/usage -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); s=d['summary']; print(f'Total: {s[\"totalRequests\"]} reqs / {s[\"totalTokens\"]} tokens / {s[\"fallbackCount\"]} fallbacks')"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 14: Export config (was broken) ──"
curl -sf http://127.0.0.1:3000/admin/api/settings/export-config -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Export OK, keys:', list(d.keys()))"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 15: Export logs CSV ──"
curl -sf http://127.0.0.1:3000/admin/api/logs/export-csv -H "Authorization: Bearer $KEY" -o /tmp/logs.csv
echo "CSV size: $(wc -c < /tmp/logs.csv) bytes"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 16: OAuth providers list ──"
curl -sf http://127.0.0.1:3000/admin/api/oauth/providers -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'OAuth providers: {len(d[\"providers\"])}')"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 17: Tunnel status ──"
curl -sf http://127.0.0.1:3000/admin/api/tunnel/status -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 18: Factory reset ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/settings/factory-reset -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 19: MCP tools list ──"
curl -sf http://127.0.0.1:3000/admin/api/mcp/tools/list -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'MCP tools: {len(d[\"tools\"])}')"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 20: ★ NEW FEATURE — Custom Provider (create) ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/custom-providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"mockcustom","name":"Mock Custom","baseUrl":"http://localhost:4123/v1","authScheme":"none","models":[{"id":"mock-llama","capabilities":{"streaming":true,"tools":true}}]}' \
  | python3 -m json.tool
echo ""

echo "── TEST 21: ★ NEW FEATURE — Custom Provider (list) ──"
curl -sf http://127.0.0.1:3000/admin/api/custom-providers -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

echo "── TEST 22: ★ NEW FEATURE — Custom Provider appears in /admin/api/providers ──"
curl -sf http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); cs=[p for p in d['providers'] if p.get('isCustom')]; print(f'Custom providers in main list: {len(cs)}'); print(cs[0] if cs else 'NONE')"
echo ""

echo "── TEST 23: ★ NEW FEATURE — Custom Provider credential ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"mockcustom","apiKey":"none","enabled":true}' | python3 -m json.tool
echo ""

echo "── TEST 24: ★ NEW FEATURE — Custom Provider in /v1/models ──"
curl -sf http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); ms=[m for m in d['data'] if m['id'].startswith('mockcustom/')]; print(f'mockcustom models: {len(ms)}'); print(ms[0] if ms else 'NONE')"
echo ""

echo "── TEST 25: ★ NEW FEATURE — Chat through Custom Provider ──"
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mockcustom/mock-llama","messages":[{"role":"user","content":"custom"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Custom provider chat OK, content:', d['choices'][0]['message']['content'])"
echo ""

echo "── TEST 26: ★ NEW FEATURE — Streaming chat through Custom Provider ──"
curl -sN -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mockcustom/mock-llama","messages":[{"role":"user","content":"stream"}],"stream":true}' | head -3
echo ""

echo "── TEST 27: ★ NEW FEATURE — Custom Provider x-api-key auth ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/custom-providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"xkeyprov","name":"X-Key Provider","baseUrl":"http://localhost:4123/v1","authScheme":"x-api-key","models":[{"id":"mock-llama"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Created x-api-key provider:', d['provider']['id'], d['provider']['authScheme'])"
echo ""

echo "── TEST 28: ★ NEW FEATURE — Custom Provider delete ──"
curl -sf -X DELETE http://127.0.0.1:3000/admin/api/custom-providers/xkeyprov -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 29: ★ NEW FEATURE — Proxy: get settings ──"
curl -sf http://127.0.0.1:3000/admin/api/proxy-settings -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

echo "── TEST 30: ★ NEW FEATURE — Proxy: add to pool ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/proxies -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"host":"127.0.0.1","port":4123,"protocol":"http"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Added proxy:', d['proxy']['id'])"
echo ""

echo "── TEST 31: ★ NEW FEATURE — Proxy: list pool ──"
curl -sf http://127.0.0.1:3000/admin/api/proxies -H "Authorization: Bearer $KEY" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Pool size: {len(d[\"proxies\"])}')"
echo ""

echo "── TEST 32: ★ NEW FEATURE — Proxy: enable routing ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/proxy-settings -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true,"strategy":"round-robin"}' | python3 -m json.tool
echo ""

echo "── TEST 33: ★ NEW FEATURE — Proxy: chat WITH routing enabled ──"
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/mock-llama","messages":[{"role":"user","content":"via-proxy"}]}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('Chat via proxy OK, content:', d['choices'][0]['message']['content'])"
echo ""

echo "── TEST 34: ★ NEW FEATURE — Proxy: validate ──"
PROXY_ID=$(curl -sf http://127.0.0.1:3000/admin/api/proxies -H "Authorization: Bearer $KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['proxies'][0]['id'])")
curl -sf -X POST "http://127.0.0.1:3000/admin/api/proxies/$PROXY_ID/validate" -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

echo "── TEST 35: ★ NEW FEATURE — Proxy: disable routing ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/proxy-settings -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"enabled":false}' | python3 -m json.tool
echo ""

echo "── TEST 36: ★ NEW FEATURE — Proxy: delete from pool ──"
curl -sf -X DELETE "http://127.0.0.1:3000/admin/api/proxies/$PROXY_ID" -H "Authorization: Bearer $KEY" | python3 -m json.tool
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST 37: Auth — login (admin/password123 default — auto-created on first boot) ──"
curl -sf -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password123"}' 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('success'), f'Login failed: {d}'
assert d['user']['username'] == 'admin', f'Wrong user: {d}'
assert d['user']['role'] == 'admin', f'Wrong role: {d}'
print(f'✓ Default admin login works: {d[\"user\"][\"username\"]} (role={d[\"user\"][\"role\"]})')
"
echo ""

echo ""
echo "=========================================="
echo "=== ALL TESTS COMPLETED SUCCESSFULLY ==="
echo "=========================================="
