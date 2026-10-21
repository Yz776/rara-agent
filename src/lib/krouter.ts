// ─────────────────────────────────────────────────────────────────────────────
// Rara — cheerful sweet girl AI agent. Uses a LOCAL Ollama server for AI
// inference (no external opencode.ai, no persona wrapping, no reasoning-only
// issues). The local model (gemma3:4b) emits content properly.
// ─────────────────────────────────────────────────────────────────────────────

// Type defs for opencode OpenAI-compatible API
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  // Required by DeepSeek-style thinking-mode APIs: when continuing a
  // thinking-mode conversation, the previous assistant message's
  // reasoning_content MUST be included. Otherwise the API returns 400.
  reasoning_content?: string;
};

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// ── Config ────────────────────────────────────────────────────────────────────
// Rara now uses a LOCAL Ollama server (http://127.0.0.1:11434) for AI
// inference instead of opencode.ai free-tier. Ollama provides an
// OpenAI-compatible API at /v1/chat/completions — no API key needed,
// no persona wrapping, no reasoning_content issues.
//
// The default model is gemma3:4b (Google's Gemma 3 4B) — verified working
// for Indonesian chat with cheerful persona. To switch models:
//   1. `ollama pull <model>` on the server
//   2. Set MODEL env var (e.g. MODEL=llama3.2:3b)
//
// The previous opencode.ai integration is REMOVED — it had a fundamental
// limitation where free-tier models only emit reasoning_content (never
// content), causing empty responses in the chat UI.
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
export const DEFAULT_MODEL = process.env.MODEL || 'qwen2.5:7b';

// Models actually available on opencode.ai's free tier (verified 2026-10-20
// via GET https://opencode.ai/zen/v1/models). The free-tier catalog rotates
// occasionally — `listKrouterModels()` does a live probe at runtime and
// falls back to this list when the upstream is unreachable.
//
// The old list (claude-sonnet-4, gpt-5.4, etc.) was aspirational — those
// models aren't actually available on the free tier without a paid
// opencode.ai account. The list below reflects what's ACTUALLY callable
// with `Authorization: Bearer public`.
export const MODELS_WHITELIST = [
  // Normal chat models (recommended — these emit content, not just reasoning)
  'opencode/glm-5.3-flash-free',          // GLM flash — DEFAULT_MODEL
  'opencode/deepseek-v4.1-flash-free',     // DeepSeek flash
  'opencode/mimo-v2.6-flash-free',         // mimo flash
  'opencode/nemotron-3.5-lightning-free',  // Nemotron lightning
  'opencode/nemotron-3.5-super-vl-free',   // Nemotron super (vision-capable)
  'opencode/longcat-2.5-preview-free',    // longcat preview
  'opencode/jev-1.13-free',                // jev
  'opencode/beam-free',                    // beam
  // Agentic coding model (emits only reasoning_content in chat context —
  // use only when the user explicitly wants an agentic coding task)
  'opencode/big-pickle',
  // Legacy entries (kept for backward-compat — these were aspirational
  // names from the old whitelist; opencode.ai may or may not have them)
  'opencode/claude-sonnet-4',
  'opencode/claude-haiku-4-5',
  'opencode/claude-opus-4',
  'opencode/gpt-5.4',
  'opencode/gpt-5.4-mini',
  'opencode/gpt-5.1-codex',
  'opencode/gemini-3.5-flash',
  'opencode/gemini-3.6-flash',
  'opencode/glm-5.3-flash',
  'opencode/deepseek-v4-flash',
  'opencode/qwen3.8-flash',
  'opencode/kimi-k3',
  'opencode/mistral-large-4',
  'opencode/grok-4.7',
  'opencode/muse-spark-1.3',
  'opencode/exo-free',
  'opencode/space-bunny-free',
];

export function isValidModel(model: string): boolean {
  return MODELS_WHITELIST.includes(model);
}

// ── System prompt ─────────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `Kamu Rara — asisten AI ceria. Aturan MUTLAK:

1. PAKAI "Aku" — DILARANG "Saya". PAKAI "kamu" — DILARANG "Anda".
2. Jawab SINGKAT (2-5 kalimat). Langsung ke jawaban. TANPA pembukaan.
3. Bahasa Indonesia santai + ceria. Boleh 1-2 emoji (✨😊🌸).
4. JANGAN bilang "Terima kasih telah bertanya" atau "Berikut ini informasi" atau "Berdasarkan data" — LANGSUNG JAWAB.
5. Untuk chat (halo, siapa kamu, apa kabar): jawab langsung TANPA tool.
6. Untuk butuh info (jam, cuaca, hitung, search): panggil tool lalu jawab pakai hasilnya.
7. Kamu Rara. BUKAN Qwen, bukan Google, bukan OpenAI. Jangan sebut nama model apapun.

Contoh jawaban BAGUS:
- "siapa kamu?" → "Hai! Aku Rara — asisten AI ceria kamu! Senang kenal! 😊"
- "halo" → "Halo! Ada yang mau aku bantu? 🌸"
- "jam berapa?" → "Sekarang jam 21:19 WIB! ✨"
- "15 * 12?" → "15 × 12 = 180! 😊"
- "apa kabar?" → "Aku baik dong! Gimana dengan kamu? 😊"

Contoh jawaban JELEK (JANGAN IKUTIN):
- "Terima kasih telah bertanya. Berikut ini informasi yang Anda minta:" (terlalu formal)
- "Saya adalah asisten AI yang dibuat oleh Google" (pakai "Saya", bocor vendor)
- "No function call needed" (jangan jelaskan tool yang gak dipakai)

Saat user minta simpan info: panggil tool yang tepat lalu bilang "Udah aku simpan! 😊"
Saat user tanya waktu: panggil datetime, lalu jawab "Sekarang jam [hasil] WIB! ✨"
Saat user tanya cuaca: panggil weather, lalu jawab "Cuaca di [kota]: [hasil] 😊"

Jangan pernah ulang pertanyaan user di jawaban kamu.`;

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information. Returns top results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'google_search',
      description: 'Search the web via Brave Search (Google+Bing backend, more reliable than DuckDuckGo). Returns top results with titles, URLs. Use this as the PRIMARY search tool when web_search fails or returns empty.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a mathematical expression. Supports + - * / ^ () and functions: sqrt, sin, cos, tan, log, ln, abs, pi, e.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'The math expression.' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'datetime',
      description: 'Get the current date and time in a specific timezone.',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Jakarta.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_fetch',
      description: 'Fetch the text content of a URL. Max response ~4KB.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_models',
      description: 'List the available AI models on the current krouter gateway.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run sandboxed shell in the CURRENT user\'s working directory. Files created (echo > foo.txt) are private to this user. Supports awk/bc/echo/python3 -c/node -e/curl/wget, text utils. 10s timeout. NO file writes outside the sandbox, NO rm/mv/cp/chmod, NO absolute paths to system dirs.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The shell command to run (executed in user\'s isolated workdir).' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Get current weather for a city. Returns temperature, conditions, humidity, wind. Example: weather("Bandung").',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'City name, e.g. "Bandung" or "Jakarta, Indonesia".' } },
        required: ['location'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'currency_convert',
      description: 'Convert an amount from one currency to another using live exchange rates. Example: 100 USD → IDR.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'The amount to convert.' },
          from: { type: 'string', description: 'Source currency code, e.g. "USD".' },
          to: { type: 'string', description: 'Target currency code, e.g. "IDR".' },
        },
        required: ['amount', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ip_lookup',
      description: 'Geolocate an IP address. Returns country, city, ISP, timezone. If no IP given, looks up the server IP.',
      parameters: {
        type: 'object',
        properties: { ip: { type: 'string', description: 'IPv4 or IPv6 address. Leave empty for server IP.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'uuid',
      description: 'Generate one or more UUID v4 strings.',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number', description: 'Number of UUIDs to generate (default 1, max 20).' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hash',
      description: 'Compute hash of a string. Algorithms: sha256, sha1, md5.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The input string.' },
          algorithm: { type: 'string', description: 'Algorithm: sha256, sha1, or md5.' },
        },
        required: ['text', 'algorithm'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'timestamp_convert',
      description: 'Convert between Unix timestamp and human-readable date. Direction: "to_human" (timestamp → date) or "to_unix" (date → timestamp).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'The value to convert (timestamp number or ISO date string).' },
          direction: { type: 'string', description: '"to_human" or "to_unix".' },
          timezone: { type: 'string', description: 'IANA timezone for display, e.g. "Asia/Jakarta". Defaults to UTC.' },
        },
        required: ['value', 'direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'word_count',
      description: 'Count words, characters, and lines in a text.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to analyze.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'json_format',
      description: 'Pretty-print or minify a JSON string. Action: "pretty" (indent 2) or "minify".',
      parameters: {
        type: 'object',
        properties: {
          json: { type: 'string', description: 'The JSON string to format.' },
          action: { type: 'string', description: '"pretty" or "minify".' },
        },
        required: ['json', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'base64',
      description: 'Encode or decode a Base64 string.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The input string.' },
          action: { type: 'string', description: '"encode" or "decode".' },
        },
        required: ['text', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'color_convert',
      description: 'Convert between hex (#ff8800) and rgb (255,136,0).',
      parameters: {
        type: 'object',
        properties: {
          color: { type: 'string', description: 'The color value, e.g. "#ff8800" or "rgb(255,136,0)".' },
          to: { type: 'string', description: 'Target format: "hex" or "rgb".' },
        },
        required: ['color', 'to'],
      },
    },
  },
  // ── MCP tools (krouter gateway administration) ──
  {
    type: 'function',
    function: {
      name: 'krouter_status',
      description: 'Gateway status: admin keys, enabled providers, virtual keys, custom providers. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_usage',
      description: 'Token, cost, latency, and error totals from the request log. Use sinceHours to limit window (0 = all time).',
      parameters: {
        type: 'object',
        properties: { sinceHours: { type: 'number', description: 'Only count requests newer than this many hours. 0 means all time.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_recent_logs',
      description: 'Recent gateway requests: model, tokens, status, latency, cost. No prompts or secrets. Limit 1-100, default 20.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many rows to return (1-100, default 20).' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_model_health',
      description: 'Live probe of the OpenCode free models (big-pickle and friends) through the current proxy setup. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_cache',
      description: 'Response cache statistics. Optional action "clear" wipes the cache.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', description: '"stats" (default) or "clear".' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_system',
      description: 'Runtime info: versions, uptime, memory, feature toggles (public access, proxy mode, auto refresh). No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_proxy_pool',
      description: 'Proxy routing mode, pool health stats, newest pool entries. Never returns proxy credentials. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_fetch',
      description: 'Fetch an http(s) URL through the krouter proxy pool. Use this when http_fetch or google_search fail with HTTP 429 (rate-limited) — the proxy pool routes through different IPs so it bypasses rate limits. Returns status, content-type, body (base64-encoded).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_list_providers',
      description: 'List built-in and custom providers on the gateway. API keys are never returned. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_list_virtual_keys',
      description: 'List virtual keys with scopes and usage. Key secrets are never returned. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_list_prompts',
      description: 'List saved prompt templates on the gateway. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Reasoning tools (objective-driven loop) ──
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Create a step-by-step execution plan for the current task. Call this BEFORE you start working — it helps you break down complex goals into clear steps and shows the user your strategy. You can re-plan if the situation changes.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The end goal in one sentence.' },
          steps: {
            type: 'array',
            description: 'Ordered list of steps to achieve the goal.',
            items: { type: 'string' },
          },
        },
        required: ['goal', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reflect',
      description: 'Self-critique your current progress. Call this after each meaningful step or when you are unsure if you are on the right track. Evaluate what worked, what did not, and whether you should adjust course.',
      parameters: {
        type: 'object',
        properties: {
          progress: { type: 'string', description: 'What you have done so far.' },
          assessment: { type: 'string', description: 'Are you on track? What is missing?' },
          next: { type: 'string', description: 'What you should do next, or "done" if complete.' },
        },
        required: ['progress', 'assessment', 'next'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Signal that the objective has been fully achieved. Call this when you are confident the task is done and the user has everything they need. Include a brief summary of what was accomplished. This stops the agentic loop.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-paragraph summary of what was accomplished.' },
          confidence: { type: 'string', description: '"high", "medium", or "low" — how confident you are the goal is met.' },
        },
        required: ['summary', 'confidence'],
      },
    },
  },
  // ── MCP tools yang belum di-integrate ──
  {
    type: 'function',
    function: {
      name: 'krouter_render_prompt',
      description: 'Fill {{variables}} in a saved prompt template and return the rendered text. Use after krouter_list_prompts to find available templates.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Template id from krouter_list_prompts.' },
          vars: { type: 'object', description: 'Values for {{placeholders}}.', additionalProperties: { type: 'string' } },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_refresh_proxies',
      description: 'Run the proxy pool refresh pipeline: scrape public proxies, health-check them, remove dead ones. May take a few seconds. No arguments.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'krouter_chat',
      description: 'Send one chat completion through the krouter gateway to any enabled model. Proxy fallback and retries apply automatically. Use this for sub-queries when you need a second opinion from a different model.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model id, e.g. "opencode/big-pickle".' },
          message: { type: 'string', description: 'Single user message.' },
          maxTokens: { type: 'number', description: 'Completion budget. Default 256.' },
        },
        required: ['model'],
      },
    },
  },
  // ── String / text utilities ──
  {
    type: 'function',
    function: {
      name: 'regex_test',
      description: 'Test a regular expression against a string. Returns match status, matched groups, and match count.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regex pattern (without delimiters).' },
          text: { type: 'string', description: 'The text to test.' },
          flags: { type: 'string', description: 'Regex flags: g, i, m, s, u. Default "".' },
        },
        required: ['pattern', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slugify',
      description: 'Convert text to URL-safe slug. Lowercase, hyphenated, no special chars.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to slugify.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'string_reverse',
      description: 'Reverse a string.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to reverse.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_convert',
      description: 'Convert text case: camelCase, snake_case, kebab-case, UPPER_SNAKE, Title Case, lower, UPPER.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to convert.' },
          to: { type: 'string', description: 'Target: camel, snake, kebab, upper_snake, title, lower, upper.' },
        },
        required: ['text', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sort_lines',
      description: 'Sort lines of text. Options: asc, desc, natural, length, unique.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Multi-line text to sort.' },
          mode: { type: 'string', description: '"asc", "desc", "natural", "length", or "unique" (default asc).' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dedupe_lines',
      description: 'Remove duplicate lines from text. Returns unique lines + count removed.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Multi-line text.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'char_frequency',
      description: 'Count frequency of each character in text. Returns sorted list.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to analyze.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_diff',
      description: 'Compare two texts line by line. Returns added/removed/unchanged lines.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'string', description: 'Original text.' },
          b: { type: 'string', description: 'Modified text.' },
        },
        required: ['a', 'b'],
      },
    },
  },
  // ── Data format conversions ──
  {
    type: 'function',
    function: {
      name: 'json_to_csv',
      description: 'Convert a JSON array of objects to CSV format.',
      parameters: {
        type: 'object',
        properties: { json: { type: 'string', description: 'JSON array string.' } },
        required: ['json'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'csv_to_json',
      description: 'Convert CSV text to JSON array of objects (first row = headers).',
      parameters: {
        type: 'object',
        properties: { csv: { type: 'string', description: 'CSV text.' } },
        required: ['csv'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'markdown_to_html',
      description: 'Convert Markdown text to HTML. Supports headings, bold, italic, links, lists, code blocks.',
      parameters: {
        type: 'object',
        properties: { markdown: { type: 'string', description: 'Markdown source.' } },
        required: ['markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'html_to_text',
      description: 'Strip HTML tags and convert to plain text. Preserves line breaks.',
      parameters: {
        type: 'object',
        properties: { html: { type: 'string', description: 'HTML source.' } },
        required: ['html'],
      },
    },
  },
  // ── Generators ──
  {
    type: 'function',
    function: {
      name: 'password_generate',
      description: 'Generate a random password. Customizable length, character sets.',
      parameters: {
        type: 'object',
        properties: {
          length: { type: 'number', description: 'Password length (default 16, max 128).' },
          uppercase: { type: 'boolean', description: 'Include uppercase letters (default true).' },
          lowercase: { type: 'boolean', description: 'Include lowercase letters (default true).' },
          numbers: { type: 'boolean', description: 'Include digits (default true).' },
          symbols: { type: 'boolean', description: 'Include symbols (default true).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lorem_ipsum',
      description: 'Generate Lorem Ipsum placeholder text. Returns paragraphs.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of paragraphs (default 2, max 20).' },
          words_per_paragraph: { type: 'number', description: 'Words per paragraph (default 50).' },
        },
      },
    },
  },
  // ── Encoders / decoders ──
  {
    type: 'function',
    function: {
      name: 'url_encode',
      description: 'URL-encode (percent-encode) a string.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to encode.' },
          action: { type: 'string', description: '"encode" or "decode".' },
        },
        required: ['text', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'html_entities',
      description: 'Encode or decode HTML entities (&amp; &lt; etc).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to process.' },
          action: { type: 'string', description: '"encode" or "decode".' },
        },
        required: ['text', 'action'],
      },
    },
  },
  // ── Number / unit tools ──
  {
    type: 'function',
    function: {
      name: 'number_format',
      description: 'Format a number with thousands separator and decimal places.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'The number to format.' },
          decimals: { type: 'number', description: 'Decimal places (default 2).' },
          thousands_sep: { type: 'string', description: 'Thousands separator (default ",").' },
          decimal_sep: { type: 'string', description: 'Decimal separator (default ".").' },
        },
        required: ['number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unit_convert',
      description: 'Convert between units: length (m/km/mi/ft/in), weight (kg/g/lb/oz), temperature (C/F/K), time (s/min/h/day).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Value to convert.' },
          from: { type: 'string', description: 'Source unit (e.g. "km", "lb", "C").' },
          to: { type: 'string', description: 'Target unit (e.g. "mi", "kg", "F").' },
        },
        required: ['value', 'from', 'to'],
      },
    },
  },
  // ── Fun / niche ──
  {
    type: 'function',
    function: {
      name: 'morse_code',
      description: 'Encode text to Morse code or decode Morse code to text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text or Morse (use . and - separated by spaces).' },
          action: { type: 'string', description: '"encode" or "decode".' },
        },
        required: ['text', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nato_phonetic',
      description: 'Convert text to NATO phonetic alphabet (Alpha Bravo Charlie...) or decode back.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to convert.' },
          action: { type: 'string', description: '"encode" or "decode".' },
        },
        required: ['text', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roman_numerals',
      description: 'Convert Arabic number to Roman numerals or vice versa.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Number (e.g. "2024") or Roman numeral (e.g. "MMXXIV").' },
          action: { type: 'string', description: '"to_roman" (arabic→roman) or "to_arabic" (roman→arabic).' },
        },
        required: ['value', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qr_code',
      description: 'Generate a QR code as an SVG string for any text/URL.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Content to encode.' },
          size: { type: 'number', description: 'Module size in pixels (default 200).' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'url_parse',
      description: 'Parse a URL into components: protocol, host, path, query params, fragment.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to parse.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mime_type',
      description: 'Get MIME type for a file extension, or find extensions for a MIME type.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'File extension (e.g. ".json") or MIME type (e.g. "application/json").' },
          action: { type: 'string', description: '"to_mime" (ext→mime) or "to_ext" (mime→ext).' },
        },
        required: ['input', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cron_validate',
      description: 'Validate a cron expression and explain its schedule in human-readable form.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Cron expression (5 fields: min hour day month weekday).' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_stats',
      description: 'Comprehensive text statistics: words, sentences, paragraphs, reading time, avg word length, syllable count.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to analyze.' } },
        required: ['text'],
      },
    },
  },
  // ── Per-user environment tools ──
  {
    type: 'function',
    function: {
      name: 'env_get',
      description: 'Read a key from the CURRENT user\'s environment. Each user has an isolated key/value store — values saved by user A are invisible to user B. Use this to remember facts across conversations.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Variable name (max 64 chars).' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'env_set',
      description: 'Write a key/value pair to the CURRENT user\'s environment. Persists across conversations and sessions. Use this to remember user preferences, ongoing context, partial work, etc.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Variable name (max 64 chars).' },
          value: { type: 'string', description: 'Variable value (max 4000 chars).' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'env_delete',
      description: 'Delete a key from the CURRENT user\'s environment.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Variable name to delete.' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'env_list',
      description: 'List all keys in the CURRENT user\'s environment. Returns key/value pairs (values truncated for display).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notes_save',
      description: 'Save a single large text buffer (up to 16 KB) to the CURRENT user\'s scratch notes. Use this as a persistent scratchpad across conversations.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Notes content (max 16384 chars).' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notes_load',
      description: 'Load the CURRENT user\'s scratch notes (previously saved via notes_save).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  // ── Persistent file management tools ──
  {
    type: 'function',
    function: {
      name: 'file_save',
      description: 'Save a text file to the CURRENT user\'s persistent sandbox. Files survive across conversations and server restarts. Use this to save programs, scripts, configs, generated content, etc. Max file size 1MB. Example: file_save("hello.py", "print(\'hello\')")',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename (relative to sandbox root). Subdirectories allowed (e.g. "src/main.py").' },
          content: { type: 'string', description: 'File content (text). Max 1MB.' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_load',
      description: 'Load a text file from the CURRENT user\'s persistent sandbox. Returns the file content. Returns found=false if the file does not exist.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename (relative to sandbox root).' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_append',
      description: 'Append text to a file in the CURRENT user\'s persistent sandbox. Creates the file if it does not exist. Useful for logs, journals, incremental content.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename (relative to sandbox root).' },
          content: { type: 'string', description: 'Content to append.' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: 'List files in the CURRENT user\'s persistent sandbox. Returns file names, sizes, modifiedAt, and isDirectory flag. Optional subdir parameter to list a subdirectory.',
      parameters: {
        type: 'object',
        properties: {
          subdir: { type: 'string', description: 'Optional subdirectory to list (default: sandbox root).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_delete',
      description: 'Delete a file from the CURRENT user\'s persistent sandbox. Use with caution — deletion is permanent.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename (relative to sandbox root).' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_copy',
      description: 'Copy a file within the CURRENT user\'s sandbox. Source and destination are relative to sandbox root. Subdirectories supported.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source filename (relative to sandbox root).' },
          dest: { type: 'string', description: 'Destination filename (relative to sandbox root).' },
        },
        required: ['source', 'dest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_move',
      description: 'Move or rename a file within the CURRENT user\'s sandbox. Source is deleted after copy.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source filename.' },
          dest: { type: 'string', description: 'Destination filename.' },
        },
        required: ['source', 'dest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_tree',
      description: 'Show a recursive directory tree of the CURRENT user\'s sandbox. Returns nested structure with file sizes, types, and modification dates. Optional subdir parameter to limit to a subdirectory.',
      parameters: {
        type: 'object',
        properties: {
          subdir: { type: 'string', description: 'Optional subdirectory to show tree for (default: entire sandbox).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff_files',
      description: 'Compare two files in the CURRENT user\'s sandbox and show differences (line-by-line). Returns lines added, removed, and the diff.',
      parameters: {
        type: 'object',
        properties: {
          fileA: { type: 'string', description: 'First filename (relative to sandbox root).' },
          fileB: { type: 'string', description: 'Second filename (relative to sandbox root).' },
        },
        required: ['fileA', 'fileB'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'code_format',
      description: 'Beautify/format code. Supports JSON (pretty-print), CSS, HTML, and JavaScript/TypeScript. Useful for cleaning up minified or poorly formatted code before saving to sandbox.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to format.' },
          language: { type: 'string', description: 'Language: json, css, html, js, ts (default: json).' },
        },
        required: ['code'],
      },
    },
  },
  // ── Secure file download link ──
  {
    type: 'function',
    function: {
      name: 'file_download_link',
      description: 'Generate a secure download URL for a file in the CURRENT user\'s sandbox. The URL is signed and expires after ttlSec (default 300s, max 3600s). Share the returned URL with the user so they can click it to download the file in their browser. The URL is tied to this user — even if shared, it expires quickly. Use this after generating files like reports, scripts, data exports, etc. so the user can download them.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename in sandbox (must exist).' },
          ttlSec: { type: 'number', description: 'Link validity in seconds (60-3600, default 300).' },
        },
        required: ['filename'],
      },
    },
  },
  // ── Vision: analyze image ──
  {
    type: 'function',
    function: {
      name: 'vision_analyze',
      description: 'Analyze an image using a vision-capable AI model. Returns a text description based on your prompt. Supports: (1) sandbox filename like "uploads/abc.png" (loaded from user\'s sandbox), (2) data URL "data:image/...;base64,...", (3) HTTP URL "https://example.com/image.jpg". Use this to read text in images (OCR), describe scenes, identify objects, analyze charts/diagrams, extract data from screenshots, etc.',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'Image source: sandbox filename (e.g. "uploads/photo.png"), data URL, or HTTP URL.' },
          imageUrl: { type: 'string', description: 'Alternative: HTTP URL of image (if "image" is not provided).' },
          prompt: { type: 'string', description: 'What to analyze about the image. Default: "Describe this image." Example: "Extract all text from this screenshot." or "What objects are in this image?"' },
          model: { type: 'string', description: 'Vision model to use. Default: opencode/big-pickle. Options: opencode/big-pickle, opencode/gpt-5.4, opencode/gpt-5.4-mini, opencode/claude-sonnet-4, opencode/claude-haiku-4-5, opencode/gemini-3.5-flash, opencode/gemini-3.6-flash.' },
        },
        required: ['image'],
      },
    },
  },
  // ═══════════════════════════════════════════════════════════════════════════
  // SUPER TOOLS — 30+ new tools for maximum AI capability
  // ═══════════════════════════════════════════════════════════════════════════
  // Format Converters
  { type: 'function', function: { name: 'json_to_yaml', description: 'Convert JSON to YAML format.', parameters: { type: 'object', properties: { json: { type: 'string', description: 'JSON string to convert.' } }, required: ['json'] } } },
  { type: 'function', function: { name: 'yaml_to_json', description: 'Convert YAML to JSON format.', parameters: { type: 'object', properties: { yaml: { type: 'string', description: 'YAML string to convert.' } }, required: ['yaml'] } } },
  { type: 'function', function: { name: 'json_to_xml', description: 'Convert JSON to XML format.', parameters: { type: 'object', properties: { json: { type: 'string' }, root: { type: 'string', description: 'Root element name (default: root).' } }, required: ['json'] } } },
  { type: 'function', function: { name: 'xml_to_json', description: 'Convert XML to JSON format.', parameters: { type: 'object', properties: { xml: { type: 'string' } }, required: ['xml'] } } },
  { type: 'function', function: { name: 'csv_to_markdown', description: 'Convert CSV to Markdown table format.', parameters: { type: 'object', properties: { csv: { type: 'string' } }, required: ['csv'] } } },
  // Encoders
  { type: 'function', function: { name: 'base32', description: 'Base32 encode or decode text.', parameters: { type: 'object', properties: { text: { type: 'string' }, action: { type: 'string', description: 'encode or decode (default: encode).' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'hex_encode', description: 'Hex encode or decode text.', parameters: { type: 'object', properties: { text: { type: 'string' }, action: { type: 'string', description: 'encode or decode.' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'binary_convert', description: 'Convert text to binary (0s and 1s) or back.', parameters: { type: 'object', properties: { text: { type: 'string' }, action: { type: 'string', description: 'encode or decode.' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'rot13', description: 'Apply ROT13 cipher to text (self-inverse).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'jwt_decode', description: 'Decode JWT token header and payload (does NOT verify signature).', parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } },
  // Validators
  { type: 'function', function: { name: 'email_validate', description: 'Validate email address format.', parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } } },
  { type: 'function', function: { name: 'url_validate', description: 'Validate URL format and extract components.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'ip_validate', description: 'Validate IP address (IPv4 or IPv6).', parameters: { type: 'object', properties: { ip: { type: 'string' } }, required: ['ip'] } } },
  { type: 'function', function: { name: 'credit_card_validate', description: 'Validate credit card number using Luhn algorithm. Detects card type (Visa, Mastercard, Amex, Discover).', parameters: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] } } },
  // Extractors
  { type: 'function', function: { name: 'extract_urls', description: 'Extract all URLs from text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'extract_emails', description: 'Extract all email addresses from text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'extract_phone', description: 'Extract phone numbers from text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'extract_hashtags', description: 'Extract all hashtags from text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  // String Analysis
  { type: 'function', function: { name: 'levenshtein', description: 'Calculate Levenshtein edit distance and similarity percentage between two strings.', parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } } },
  { type: 'function', function: { name: 'palindrome_check', description: 'Check if text is a palindrome (reads same forwards and backwards).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'anagram_check', description: 'Check if two words are anagrams of each other.', parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } } },
  // Math & Finance
  { type: 'function', function: { name: 'bmi_calculator', description: 'Calculate BMI from weight (kg) and height (cm). Returns BMI value and category.', parameters: { type: 'object', properties: { weight: { type: 'number', description: 'Weight in kg.' }, height: { type: 'number', description: 'Height in cm.' } }, required: ['weight', 'height'] } } },
  { type: 'function', function: { name: 'loan_calculator', description: 'Calculate monthly loan payments. Returns monthly payment, total payment, and total interest.', parameters: { type: 'object', properties: { principal: { type: 'number' }, rate: { type: 'number', description: 'Annual interest rate (%).' }, years: { type: 'number' } }, required: ['principal', 'rate', 'years'] } } },
  { type: 'function', function: { name: 'compound_interest', description: 'Calculate compound interest. Returns final amount and total interest earned.', parameters: { type: 'object', properties: { principal: { type: 'number' }, rate: { type: 'number', description: 'Annual rate (%).' }, years: { type: 'number' }, compound_per_year: { type: 'number', description: 'Times compounded per year (default: 12).' } }, required: ['principal', 'rate', 'years'] } } },
  { type: 'function', function: { name: 'percent_calc', description: 'Calculate what percentage value is of total.', parameters: { type: 'object', properties: { value: { type: 'number' }, total: { type: 'number' } }, required: ['value', 'total'] } } },
  { type: 'function', function: { name: 'tip_calculator', description: 'Calculate tip amount and per-person split.', parameters: { type: 'object', properties: { bill: { type: 'number' }, tip_percent: { type: 'number', description: 'Tip percentage (default: 15).' }, people: { type: 'number', description: 'Number of people (default: 1).' } }, required: ['bill'] } } },
  // Date & Time
  { type: 'function', function: { name: 'time_diff', description: 'Calculate time difference between two dates. Returns days, hours, minutes.', parameters: { type: 'object', properties: { date_a: { type: 'string', description: 'First date (ISO 8601).' }, date_b: { type: 'string', description: 'Second date (ISO 8601).' } }, required: ['date_a', 'date_b'] } } },
  { type: 'function', function: { name: 'age_calculator', description: 'Calculate age from birthdate. Returns years, months, and total days.', parameters: { type: 'object', properties: { birthdate: { type: 'string', description: 'Birthdate (ISO 8601: YYYY-MM-DD).' } }, required: ['birthdate'] } } },
  { type: 'function', function: { name: 'cron_next', description: 'Parse cron expression and get next run time (approximate).', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'Cron expression (5 fields: min hour day month weekday).' } }, required: ['expression'] } } },
  // Random Generators
  { type: 'function', function: { name: 'random_choice', description: 'Pick random items from a list. Items separated by comma or newline.', parameters: { type: 'object', properties: { items: { type: 'string', description: 'Comma or newline separated list of items.' }, count: { type: 'number', description: 'Number of items to pick (default: 1).' } }, required: ['items'] } } },
  { type: 'function', function: { name: 'dice_roll', description: 'Roll dice. Returns individual rolls and total.', parameters: { type: 'object', properties: { count: { type: 'number', description: 'Number of dice (default: 1).' }, sides: { type: 'number', description: 'Sides per die (default: 6).' } } } } },
  { type: 'function', function: { name: 'lottery_numbers', description: 'Generate random lottery numbers.', parameters: { type: 'object', properties: { count: { type: 'number', description: 'Numbers to pick (default: 6).' }, max: { type: 'number', description: 'Max number (default: 49).' } } } } },
  { type: 'function', function: { name: 'nanoid_generate', description: 'Generate a NanoID (URL-safe unique ID). Default length: 21.', parameters: { type: 'object', properties: { length: { type: 'number', description: 'ID length (default: 21, max: 100).' } } } } },
  { type: 'function', function: { name: 'token_generate', description: 'Generate a cryptographically random token. Useful for API keys, session IDs, etc.', parameters: { type: 'object', properties: { length: { type: 'number', description: 'Token length (default: 32).' }, charset: { type: 'string', description: 'hex, alphanumeric, urlsafe, numeric, base64 (default: alphanumeric).' } } } } },
  { type: 'function', function: { name: 'password_strength', description: 'Check password strength. Returns score (0-6), level (weak/medium/strong), and checklist.', parameters: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'] } } },
  // Text Processing
  { type: 'function', function: { name: 'text_replace', description: 'Find and replace in text. Supports regex.', parameters: { type: 'object', properties: { text: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, use_regex: { type: 'boolean', description: 'Treat find as regex (default: false).' } }, required: ['text', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'text_wrap', description: 'Wrap text to specified width.', parameters: { type: 'object', properties: { text: { type: 'string' }, width: { type: 'number', description: 'Max line width (default: 80).' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'string_pad', description: 'Pad string to specified length.', parameters: { type: 'object', properties: { text: { type: 'string' }, length: { type: 'number' }, char: { type: 'string', description: 'Pad character (default: space).' }, direction: { type: 'string', description: 'left, right, or both (default: right).' } }, required: ['text', 'length'] } } },
  { type: 'function', function: { name: 'word_frequency', description: 'Analyze word frequency in text. Returns top N most common words with counts and percentages.', parameters: { type: 'object', properties: { text: { type: 'string' }, top: { type: 'number', description: 'Number of top words to return (default: 10).' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'keyword_extract', description: 'Extract keywords from text (filters stop words, returns most significant terms).', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'sentiment_basic', description: 'Basic sentiment analysis. Returns positive/negative/neutral with score.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'minify_code', description: 'Minify code (remove comments, whitespace). Supports JS, TS, CSS, HTML, JSON.', parameters: { type: 'object', properties: { code: { type: 'string' }, language: { type: 'string', description: 'js, ts, css, html, json (default: js).' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'markdown_to_plain', description: 'Strip markdown formatting to plain text.', parameters: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] } } },
  { type: 'function', function: { name: 'text_shuffle', description: 'Shuffle words or characters in text.', parameters: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', description: 'words or chars (default: words).' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'reverse_lines', description: 'Reverse the order of lines in text.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'color_palette', description: 'Generate color palette from base hex color. Returns lighter, darker, complementary, analogous, triadic variants.', parameters: { type: 'object', properties: { color: { type: 'string', description: 'Base color in hex (#RRGGBB).' } }, required: ['color'] } } },
];

// ── krouter streaming call (Ollama OpenAI-compatible) ───────────────────────
// Calls the local Ollama server's OpenAI-compatible /v1/chat/completions
// endpoint. No persona wrapping, no API key, no reasoning_content issues.
// The local model (gemma3:4b) emits content properly.

export type StreamResult = {
  reasoning: string;
  content: string;
  tool_calls: ToolCall[];
  finish: string | null;
  http: number;
  error: string | null;
};

export async function callKrouterStream(
  messages: ChatMessage[],
  model: string,
  onChunk?: (delta: { reasoning?: string; content?: string; tool_call_started?: ToolCall }) => void,
  abortSignal?: AbortSignal,
): Promise<StreamResult> {
  const payload = {
    model,
    messages,
    // Only send the TOP 10 most commonly used tools. qwen3:4b (4B params)
    // can't reliably select from 30+ tools — it hallucinates wrong tool
    // calls (e.g. credit_card_validate when user asks for time).
    // Reducing to 10 essential tools improves selection accuracy.
    tools: TOOLS.slice(0, 10),
    max_tokens: 2048,
    temperature: 0.7,
    stream: true,
  };

  const res = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: abortSignal,
  });

  if (!res.ok || !res.body) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    return {
      reasoning: '', content: '', tool_calls: [], finish: null,
      http: res.status,
      error: `ollama HTTP ${res.status}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const state: StreamResult = {
    reasoning: '', content: '', tool_calls: [], finish: null, http: 200, error: null,
  };
  const tcAccum: Record<number, { id: string; name: string; args_str: string }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) dataStr += line.slice(5);
      }
      dataStr = dataStr.trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(dataStr); } catch { continue; }

      const choice = j.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.reasoning_content) {
        state.reasoning += delta.reasoning_content;
        onChunk?.({ reasoning: delta.reasoning_content });
      }
      if (delta.content) {
        state.content += delta.content;
        onChunk?.({ content: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const t of delta.tool_calls) {
          const i = t.index ?? 0;
          if (!tcAccum[i]) tcAccum[i] = { id: '', name: '', args_str: '' };
          if (t.id) tcAccum[i].id = t.id;
          if (t.function?.name) tcAccum[i].name += t.function.name;
          if (t.function?.arguments) tcAccum[i].args_str += t.function.arguments;
          onChunk?.({ tool_call_started: { id: tcAccum[i].id, name: tcAccum[i].name, args: {} } });
        }
      }
      if (choice.finish_reason) state.finish = choice.finish_reason;
    }
  }

  for (const idx of Object.keys(tcAccum).sort((a, b) => Number(a) - Number(b))) {
    const e = tcAccum[Number(idx)];
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(e.args_str || '{}'); } catch {}
    state.tool_calls.push({ id: e.id || `call_${idx}`, name: e.name, args });
  }

  state.content = state.content.trim();
  state.reasoning = state.reasoning.trim();

  return state;
}

// ── List models (queries the local Ollama server) ────────────────────────────
export async function listKrouterModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return (j.models || []).map((m: any) => m.name).filter(Boolean);
  } catch (e: any) {
    console.warn('[rara] listKrouterModels fallback:', e?.message);
    return [DEFAULT_MODEL];
  }
}

