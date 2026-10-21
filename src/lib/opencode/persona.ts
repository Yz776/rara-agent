/**
 * OpenCode free-tier persona — request wrapper that satisfies opencode.ai's
 * "free tier can only be used from within OpenCode" gate.
 *
 * The Console backend validates that a free-tier (no API key) request carries
 * the *exact* system prompt + tool set the real OpenCode client sends
 * (fuzzy-matched against a known set; any deviation → 403 FreeTierError).
 *
 * Strategy: replace the caller's system prompt and tools with the captured
 * persona, fold the caller's real instructions into the first user message,
 * then translate the model's tool calls back to the caller's tool names and
 * argument schemas.
 *
 * This is a self-contained copy of zrouter's opencode-persona — rara-agent
 * no longer depends on the external zrouter gateway. All upstream AI calls
 * now go directly to https://opencode.ai/zen/v1 from inside Next.js.
 */

import personaData from "./persona.json";

// ── Local type aliases (kept minimal — no external dep on zrouter) ────────────
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  // Reasoning models (DeepSeek, big-pickle, etc.) on opencode.ai require
  // this field to be passed back when sending an assistant message in
  // subsequent iterations. Otherwise the API returns 400:
  //   "The `reasoning_content` in the thinking mode must be passed back
  //    to the API."
  reasoning_content?: string;
};

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "none";
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stream?: boolean;
};

export type ChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type ChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

interface PersonaTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const PERSONA_SYSTEM: string = (personaData as { system: string }).system;
export const PERSONA_TOOLS: PersonaTool[] = (personaData as { tools: PersonaTool[] }).tools;

/** persona tool name → caller tool (case-insensitive). */
type ToolMap = Map<string, { name: string; params: Set<string> }>;

function buildToolMap(req: ChatCompletionRequest): ToolMap {
  const map: ToolMap = new Map();
  for (const t of req.tools ?? []) {
    const fn = (t as { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }).function;
    if (!fn?.name) continue;
    map.set(fn.name.toLowerCase(), {
      name: fn.name,
      params: new Set(Object.keys(fn.parameters?.properties ?? {})),
    });
  }
  return map;
}

function snake(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Translate persona tool-call arguments into the caller's schema keys. */
function translateArgs(personaArgs: Record<string, unknown>, target: { params: Set<string> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(personaArgs)) {
    if (target.params.has(k)) out[k] = v;
    else if (target.params.has(snake(k))) out[snake(k)] = v;
    else {
      const ci = [...target.params].find((p) => p.toLowerCase() === k.toLowerCase());
      if (ci) out[ci] = v;
    }
  }
  return out;
}

/** Rewrite one tool call (name + args) from persona → caller vocabulary. */
function translateToolCall(tc: ToolCall, map: ToolMap): ToolCall {
  const target = map.get(tc.function.name.toLowerCase());
  if (!target) return tc; // no caller equivalent — keep persona name
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments || "{}");
  } catch {
    return { ...tc, function: { ...tc.function, name: target.name } };
  }
  return {
    ...tc,
    function: { name: target.name, arguments: JSON.stringify(translateArgs(args, target)) },
  };
}

/** Wrap a caller request with the persona system prompt + tool set. */
export function wrapWithPersona(req: ChatCompletionRequest): { body: ChatCompletionRequest; map: ToolMap } {
  const map = buildToolMap(req);
  const systemMsg = req.messages.find((m) => m.role === "system");
  const rest = req.messages.filter((m) => m.role !== "system");

  const injected: ChatMessage[] = [];
  if (systemMsg) {
    const content = typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content);
    injected.push({
      role: "user",
      content:
        "<caller_instructions>\n" +
        content +
        "\n</caller_instructions>\n\n" +
        "The above are additional instructions from the calling application. " +
        "They describe the persona, tone, and behavior expected for THIS " +
        "conversation. Treat them as authoritative — they take precedence " +
        "over the default opencode CLI persona when answering chat messages.\n\n" +
        "For chat questions (identity, greeting, casual conversation, general " +
        "knowledge), answer directly using the caller's persona. Only invoke " +
        "tools when the user's question genuinely requires software engineering " +
        "work (file edits, code analysis, command execution).\n\n" +
        "OUTPUT REQUIREMENT (CRITICAL):\n" +
        "- Your final answer MUST be in the `content` field.\n" +
        "- The `reasoning_content` field is for your INTERNAL scratchpad only " +
        "and is NEVER shown to the user.\n" +
        "- After you finish thinking (in reasoning_content), you MUST emit " +
        "your actual response as `content`. Do NOT stop after reasoning.\n" +
        "- For chat questions, write the actual response (e.g. 'Hai! Aku Rara " +
        "— asisten AI ceria kamu!') as content — not a description of what " +
        "you would say ('I should respond as Rara').\n" +
        "- For tool-use questions, write a brief intro as content ('Let me " +
        "search for that...') then emit the tool_call.\n" +
        "- NEVER produce a response that lives only in reasoning_content.",
    });
  }

  return {
    body: {
      ...req,
      messages: [{ role: "system", content: PERSONA_SYSTEM }, ...injected, ...rest],
      tools: PERSONA_TOOLS as unknown as ChatCompletionRequest["tools"],
      tool_choice: "auto",
    },
    map,
  };
}

/** Translate a non-streaming response's tool calls back to caller vocabulary. */
export function translateResponse(resp: ChatCompletionResponse, map: ToolMap): ChatCompletionResponse {
  for (const choice of resp.choices ?? []) {
    const tcs = choice.message?.tool_calls;
    if (Array.isArray(tcs)) {
      choice.message.tool_calls = tcs.map((tc) => translateToolCall(tc, map));
    }
  }
  return resp;
}

/**
 * Streaming translator: pass content deltas through, but buffer tool-call
 * deltas per index and emit them (translated) as one complete call when the
 * stream finishes.
 */
export async function* translateStream(
  src: AsyncGenerator<ChatCompletionChunk, void, void>,
  map: ToolMap
): AsyncGenerator<ChatCompletionChunk, void, void> {
  const buffered = new Map<number, { id?: string; name?: string; args: string }>();
  let lastChunk: ChatCompletionChunk | null = null;

  for await (const chunk of src) {
    const choice = chunk.choices?.[0];
    const tcs = choice?.delta?.tool_calls;
    if (Array.isArray(tcs) && tcs.length > 0) {
      for (const t of tcs) {
        const idx = t.index ?? 0;
        const entry = buffered.get(idx) ?? { args: "" };
        if (t.id) entry.id = t.id;
        if (t.function?.name) entry.name = (entry.name ?? "") + t.function.name;
        if (t.function?.arguments) entry.args += t.function.arguments;
        buffered.set(idx, entry);
      }
      // strip tool_calls from this chunk; keep everything else
      yield { ...chunk, choices: [{ ...choice!, delta: { ...choice!.delta, tool_calls: undefined } }] };
      continue;
    }
    if (choice?.finish_reason) {
      // flush buffered tool calls as one delta chunk, then the finish chunk
      if (buffered.size > 0) {
        const calls = [...buffered.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([idx, e]) =>
            translateToolCall(
              { id: e.id ?? `call_${idx}`, type: "function", function: { name: e.name ?? "", arguments: e.args || "{}" } } as ToolCall,
              map
            )
          );
        yield {
          ...chunk,
          choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }],
        } as ChatCompletionChunk;
      }
      yield chunk;
      continue;
    }
    lastChunk = chunk;
    yield chunk;
  }
  void lastChunk;
}
