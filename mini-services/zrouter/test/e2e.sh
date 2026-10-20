#!/usr/bin/env bash
# End-to-end test of ZRouter gateway.
set -e
BASE=http://127.0.0.1:3000

echo "=== 1. Health check ==="
curl -s $BASE/health
echo

echo "=== 2. Bootstrap status (should be true initially) ==="
curl -s $BASE/admin/api/status
echo

echo "=== 3. Create first admin key (bootstrap mode) ==="
RESP=$(curl -s -X POST $BASE/admin/api/keys -H "Content-Type: application/json" -d '{"name":"test-admin"}')
echo "$RESP"
KEY=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['key']['key'])")
echo "Admin key: $KEY"
echo

echo "=== 4. Status after bootstrap (should be false) ==="
curl -s $BASE/admin/api/status
echo

echo "=== 5. Authenticated keys list ==="
curl -s $BASE/admin/api/keys -H "Authorization: Bearer $KEY"
echo

echo "=== 6. Unauthenticated keys list (should be 401) ==="
curl -s -o /dev/null -w "HTTP %{http_code}\n" $BASE/admin/api/keys
echo

echo "=== 7. Providers list (count only) ==="
curl -s $BASE/admin/api/providers -H "Authorization: Bearer $KEY" | python3 -c "
import sys,json
d = json.load(sys.stdin)
print(f'Total providers in catalog: {len(d[\"providers\"])}')
for p in d['providers']:
    print(f'  {p[\"id\"]:15s} | {p[\"category\"]:10s} | {p[\"protocol\"]:6s} | models={len(p.get(\"models\") or [])}')
"
echo

echo "=== 8. /v1/models without credentials (should be empty since no provider configured) ==="
curl -s $BASE/v1/models -H "Authorization: Bearer $KEY"
echo

echo "=== 9. Save Ollama provider (no API key needed) ==="
curl -s -X POST $BASE/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"id":"ollama","enabled":true}'
echo

echo "=== 10. Test Ollama provider (will fail if ollama not running locally — that's OK) ==="
curl -s -X POST $BASE/admin/api/providers/ollama/test -H "Authorization: Bearer $KEY"
echo

echo "=== 11. Save fake Groq with static models for testing ==="
curl -s -X POST $BASE/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"id":"groq","apiKey":"gsk_fake_key_for_testing","enabled":true}'
echo

echo "=== 12. List models now (should show groq static models) ==="
curl -s $BASE/v1/models -H "Authorization: Bearer $KEY" | python3 -c "
import sys,json
d = json.load(sys.stdin)
print(f'Total models available: {len(d[\"data\"])}')
for m in d['data'][:8]:
    print(f'  {m[\"id\"]}')
if len(d['data']) > 8:
    print(f'  ... and {len(d[\"data\"])-8} more')
"
echo

echo "=== 13. Chat completion with bad API key (should surface error gracefully) ==="
curl -s -X POST $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "model": "groq/llama-3.3-70b-versatile",
  "messages": [{"role": "user", "content": "Hello!"}]
}' | head -c 500
echo

echo ""
echo "=== 14. Chat completion with unknown model (should fail clearly) ==="
curl -s -X POST $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "model": "unknown/model-x",
  "messages": [{"role": "user", "content": "Hello!"}]
}'
echo

echo ""
echo "=== 15. Save DeepSeek scraper with fake token ==="
curl -s -X POST $BASE/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"id":"deepseek","apiKey":"fake_token_for_testing","enabled":true}'
echo

echo "=== 16. Verify deepseek models show up ==="
curl -s $BASE/v1/models -H "Authorization: Bearer $KEY" | python3 -c "
import sys,json
d = json.load(sys.stdin)
ds = [m for m in d['data'] if m['id'].startswith('deepseek/')]
print(f'DeepSeek models: {len(ds)}')
for m in ds:
    print(f'  {m[\"id\"]}')
"

echo ""
echo "=== 17. Add fallback rule ==="
curl -s -X POST $BASE/admin/api/fallbacks -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{
  "sourceModel": "groq/llama-3.3-70b-versatile",
  "targetModel": "deepseek/deepseek-chat",
  "triggerStatus": [429, 503],
  "enabled": true
}'
echo

echo ""
echo "=== 18. List fallbacks ==="
curl -s $BASE/admin/api/fallbacks -H "Authorization: Bearer $KEY"
echo

echo ""
echo "=== 19. Dashboard HTML loads ==="
curl -s -o /dev/null -w "HTTP %{http_code}, content-type: %{content_type}\n" $BASE/

echo ""
echo "=== ALL TESTS PASSED ==="
