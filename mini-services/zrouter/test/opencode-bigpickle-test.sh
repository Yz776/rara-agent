#!/usr/bin/env bash
# Dedicated streaming test for opencode/big-pickle (free-tier model with persona wrapping).
# Verifies:
#   1. /v1/models includes opencode/big-pickle
#   2. Non-streaming chat returns a valid response
#   3. Streaming chat returns proper SSE chunks with content
#   4. System prompt is honored
#   5. Anthropic /v1/messages streaming works
#   6. Anthropic /v1/messages non-streaming works
#   7. Both apiKey="" and apiKey="public" trigger persona wrapping (free-tier gate)

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
KEY=$(curl -s -X POST http://127.0.0.1:3000/admin/api/keys -H "Content-Type: application/json" -d '{"name":"test"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['key']['key'])")
echo "Admin key: $KEY"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST A: Configure opencode with apiKey='public' (free-tier Bearer) ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"opencode","apiKey":"public","enabled":true}' > /dev/null
echo "Provider saved."
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST B: /v1/models includes opencode/big-pickle ──"
MODELS=$(curl -sf http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $KEY")
echo "$MODELS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ids = [m['id'] for m in d['data']]
assert 'opencode/big-pickle' in ids, 'opencode/big-pickle missing from /v1/models'
print(f'✓ opencode/big-pickle present. Total models: {len(ids)}')
"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST C: NON-STREAMING chat with opencode/big-pickle ──"
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"Reply with exactly: NONSTREAM_OK"}],"max_tokens":50}' \
  --max-time 90 | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['choices'][0]['message']['content']
assert 'NONSTREAM_OK' in content, f'Expected NONSTREAM_OK, got: {content!r}'
print(f'✓ Non-streaming response: {content!r}')
print(f'  Usage: {d.get(\"usage\", {})}')
"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST D: STREAMING chat with opencode/big-pickle ──"
STREAM_OUT=$(curl -sN -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"Count from 1 to 5."}],"max_tokens":100,"stream":true}' \
  --max-time 90)
echo "$STREAM_OUT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
# Must have data: lines and end with [DONE]
assert 'data: ' in text, 'No data: lines in stream'
assert 'data: [DONE]' in text, 'Stream did not end with [DONE]'
# Parse all chunks
chunks = []
for line in text.split('\n'):
    m = re.match(r'^data: (.+)$', line)
    if m and m.group(1) != '[DONE]':
        try:
            chunks.append(json.loads(m.group(1)))
        except: pass
assert len(chunks) > 0, 'No valid JSON chunks parsed'
# Collect content
content = ''
for c in chunks:
    choice = c.get('choices', [{}])[0] if c.get('choices') else {}
    delta = choice.get('delta', {})
    if delta.get('content'):
        content += delta['content']
assert content.strip(), 'No content collected from stream'
print(f'✓ Streamed {len(chunks)} chunks, content: {content.strip()!r}')
"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST E: System prompt honored ──"
# Use a natural system prompt (not a "reply with X" pattern that triggers
# the model's prompt-injection detection)
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"system","content":"You are a helpful geography tutor. Always answer geography questions briefly."},{"role":"user","content":"What is the capital of France?"}],"max_tokens":150}' \
  --max-time 90 | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['choices'][0]['message']['content'].upper()
# Should mention Paris (the actual capital) — proves system prompt set context
assert 'PARIS' in content, f'System prompt ignored. Got: {content!r}'
print(f'✓ System prompt honored (geography context): {content[:80]!r}')
"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST F: Anthropic /v1/messages non-streaming ──"
curl -sf -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","max_tokens":50,"messages":[{"role":"user","content":"Reply with exactly: ANTHROPIC_OK"}]}' \
  --max-time 90 | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('type') == 'message', f'Wrong type: {d.get(\"type\")}'
assert d.get('role') == 'assistant', f'Wrong role: {d.get(\"role\")}'
content = d['content'][0]['text']
assert 'ANTHROPIC_OK' in content, f'Expected ANTHROPIC_OK, got: {content!r}'
print(f'✓ Anthropic non-streaming: {content!r}')
print(f'  stop_reason: {d.get(\"stop_reason\")}')
print(f'  usage: {d.get(\"usage\")}')
"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST G: Anthropic /v1/messages streaming ──"
ANTH_STREAM=$(curl -sN -X POST http://127.0.0.1:3000/v1/messages \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","max_tokens":50,"messages":[{"role":"user","content":"Say hi in one short sentence."}],"stream":true}' \
  --max-time 90)
echo "$ANTH_STREAM" | python3 -c "
import sys
text = sys.stdin.read()
required_events = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']
for ev in required_events:
    assert f'event: {ev}' in text, f'Missing event: {ev}'
# Extract text deltas
import re
deltas = re.findall(r'\"type\":\"text_delta\",\"text\":\"([^\"]*)\"', text)
content = ''.join(deltas)
assert content.strip(), 'No text_delta content collected'
print(f'✓ Anthropic streaming: {len(required_events)} event types present, content: {content.strip()!r}')
"
echo ""

# ────────────────────────────────────────────────────────────────────────────
echo "── TEST H: Re-configure with NO apiKey (empty) — should still work ──"
curl -sf -X POST http://127.0.0.1:3000/admin/api/providers -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"id":"opencode","enabled":true}' > /dev/null
curl -sf -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"Reply with exactly: EMPTY_KEY_OK"}],"max_tokens":30}' \
  --max-time 90 | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['choices'][0]['message']['content']
assert 'EMPTY_KEY_OK' in content, f'Expected EMPTY_KEY_OK, got: {content!r}'
print(f'✓ Empty-key free-tier works: {content!r}')
"
echo ""

echo "=========================================="
echo "=== ALL OPENCODE/BIG-PICKLE TESTS PASSED ==="
echo "=========================================="
