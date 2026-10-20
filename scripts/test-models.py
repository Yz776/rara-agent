#!/usr/bin/env python3
"""Test all opencode.ai free-tier models with persona wrapping."""
import json
import urllib.request
import ssl

persona = json.load(open("/opt/rara-agent/src/lib/opencode/persona.json"))
CALLER = "You are Rara, a cheerful AI assistant. Reply in Indonesian."

INJECTED = (
    "<caller_instructions>\n"
    + CALLER
    + "\n</caller_instructions>\n\n"
    + "Follow them. Answer in content field, NOT reasoning."
)

MODELS = [
    "big-pickle",
    "glm-5.3-flash-free",
    "deepseek-v4.1-flash-free",
    "beam-free",
    "mimo-v2.6-flash-free",
    "nemotron-3.5-lightning-free",
    "jev-1.13-free",
    "longcat-2.5-preview-free",
]

for model in MODELS:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": persona["system"]},
            {"role": "user", "content": INJECTED},
            {"role": "user", "content": "halo, siapa kamu?"},
        ],
        "tools": persona["tools"],
        "tool_choice": "auto",
        "stream": True,
        "max_tokens": 200,
    }).encode()
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
            n_c = n_r = 0
            sample_c = ""
            sample_r = ""
            finish = None
            for raw in res:
                line = raw.decode().rstrip()
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
                    if len(sample_c) < 200:
                        sample_c += d["content"]
                if d.get("reasoning_content"):
                    n_r += 1
                    if len(sample_r) < 200:
                        sample_r += d["reasoning_content"]
                if ch.get("finish_reason"):
                    finish = ch["finish_reason"]
            print(f"  {model}: content_chunks={n_c} reasoning_chunks={n_r} finish={finish}")
            print(f"    content: {sample_c[:200]!r}")
            print(f"    reasoning: {sample_r[:200]!r}")
            print()
    except urllib.error.HTTPError as e:
        print(f"  {model}: HTTP {e.code} - {e.read().decode()[:200]}")
        print()
    except Exception as e:
        print(f"  {model}: error {e}")
        print()
