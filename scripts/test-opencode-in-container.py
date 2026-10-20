#!/usr/bin/env python3
"""Test opencode.ai from inside kali container — uses host's persona.json."""
import json
import urllib.request
import ssl
import sys

persona = json.load(open("/opt/rara-agent/src/lib/opencode/persona.json"))
CALLER_SYSTEM = (
    "Kamu adalah Rara - asisten AI ceria. "
    "Saat ditanya siapa kamu, jawab pendek dalam Bahasa Indonesia."
)

messages = [
    {"role": "system", "content": persona["system"]},
    {
        "role": "user",
        "content": (
            "<caller_instructions>\n"
            + CALLER_SYSTEM
            + "\n</caller_instructions>\n\n"
            + "Follow them. Answer directly without tools when no tool is needed."
        ),
    },
    {"role": "user", "content": "halo, siapa kamu?"},
]

body = json.dumps(
    {
        "model": "big-pickle",
        "messages": messages,
        "tools": persona["tools"],
        "tool_choice": "auto",
        "stream": True,
        "max_tokens": 300,
    }
).encode()

req = urllib.request.Request(
    "https://opencode.ai/zen/v1/chat/completions",
    data=body,
    headers={
        "Authorization": "Bearer public",
        "Content-Type": "application/json",
        "User-Agent": "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
        "x-opencode-client": "cli",
        "x-opencode-session": "ses_" + "a" * 20,
        "x-opencode-request": "msg_" + "b" * 20,
        "x-opencode-project": "c" * 40,
        "Accept": "text/event-stream",
    },
)

ctx = ssl.create_default_context()
try:
    with urllib.request.urlopen(req, timeout=30, context=ctx) as res:
        print(f"HTTP {res.status}")
        n_c = n_r = n_t = 0
        sample_c = ""
        sample_r = ""
        finish = None
        for raw in res:
            line = raw.decode("utf-8", "replace").rstrip()
            if not line.startswith("data:"):
                continue
            s = line[5:].strip()
            if not s or s == "[DONE]":
                continue
            try:
                chunk = json.loads(s)
            except Exception:
                continue
            ch = chunk.get("choices", [{}])[0]
            d = ch.get("delta", {})
            if d.get("content"):
                n_c += 1
                if len(sample_c) < 400:
                    sample_c += d["content"]
            if d.get("reasoning_content"):
                n_r += 1
                if len(sample_r) < 400:
                    sample_r += d["reasoning_content"]
            if d.get("tool_calls"):
                n_t += 1
            if ch.get("finish_reason"):
                finish = ch["finish_reason"]
        print(f"content_chunks={n_c} reasoning_chunks={n_r} tool_chunks={n_t} finish={finish}")
        print(f"sample_content={sample_c!r}")
        print(f"sample_reasoning={sample_r!r}")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}")
except Exception as e:
    print(f"error: {e}")
