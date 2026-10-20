/**
 * Token Saver — prompt compression pipeline.
 *
 * Applies four passes to a ChatCompletionRequest before sending it upstream:
 *
 * 1. Compress tool output — auto-detects git diff/status/log, grep, ls, tree,
 *    build output, generic logs, and applies format-specific compression.
 * 2. System-prompt enhancement — appends "lazy senior dev" + "compress output"
 *    instructions (opt-in).
 * 3. Per-message token truncation — strips trailing chars if a single message
 *    exceeds maxInputTokens.
 * 4. Trim messages — replaces oldest tool messages with placeholders while
 *    preserving tool_call_id pairing.
 *
 * Fail-open: every pass is wrapped in try/catch. If anything fails, the
 * original request is returned unchanged.
 */

import type { ChatCompletionRequest, ChatMessage } from "../types";
import { rtkCompress, shouldCompress } from "./rtk-filters";

export interface TokenSaverSettings {
  enabled: boolean;
  compressToolOutput: {
    enabled: boolean;
    minCharacterThreshold: number;
  };
  lazySeniorDev: {
    enabled: boolean;
    mode: "balanced" | "strict";
  };
  compressLlmOutput: {
    enabled: boolean;
    mode: "terse" | "ultra_terse";
  };
  trimMessages: {
    enabled: boolean;
    maxInputTokens: number;
    preserveTailMessages: number;
  };
}

export const DEFAULT_TOKEN_SAVER_SETTINGS: TokenSaverSettings = {
  enabled: true,
  compressToolOutput: {
    enabled: true,
    minCharacterThreshold: 500,
  },
  lazySeniorDev: {
    enabled: false,
    mode: "balanced",
  },
  compressLlmOutput: {
    enabled: false,
    mode: "terse",
  },
  trimMessages: {
    enabled: true,
    maxInputTokens: 32_768,
    preserveTailMessages: 4,
  },
};

interface ApplyResult {
  request: ChatCompletionRequest;
  originalInputTokens: number;
  optimizedInputTokens: number;
  tokensSaved: number;
  percentageSaved: number;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function messageToText(msg: ChatMessage): string {
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => ("text" in p ? p.text ?? "" : ""))
      .join("");
  }
  return "";
}

function setMessageText(msg: ChatMessage, text: string): ChatMessage {
  return { ...msg, content: text };
}

const LAZY_SENIOR_DEV_PROMPT = `
You are a lazy senior developer. Apply YAGNI strictly:
- Don't add code that isn't needed for the immediate task
- Prefer stdlib over third-party packages
- Make minimal, surgical edits — don't refactor unrelated code
- If the existing code works, don't rewrite it
- Use the platform's built-in capabilities before reaching for a library
`.trim();

const TERSE_OUTPUT_PROMPT = `
Be terse. Skip pleasantries, confirmations, and restatements.
Use code blocks for code. Use brief bullet points for prose.
No "Here is..." / "I'll..." / "Let me..." preambles.
`.trim();

const ULTRA_TERSE_PROMPT = `
Ultra-terse output mode. Use caveman-speak for non-code text.
- "Adding file X" instead of "I'll add the file X to the project"
- "Fix: change Y to Z" instead of "The issue is that Y, I'll change it to Z"
- Keep code blocks, paths, and error messages exact and verbatim
- No greetings, no apologies, no explanations unless explicitly asked
`.trim();

function injectSystemPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  if (!messages.length) return messages;
  // If first message is system, append
  if (messages[0]!.role === "system") {
    const sys = messages[0]!;
    const sysText = messageToText(sys);
    if (sysText.includes(prompt)) return messages;
    return [setMessageText(sys, `${sysText}\n\n${prompt}`), ...messages.slice(1)];
  }
  // Otherwise insert new system message at top
  return [{ role: "system", content: prompt }, ...messages];
}

/** Compress a single tool/user message's text content using RTK filters. */
function compressMessageContent(
  msg: ChatMessage,
  minChars: number
): { msg: ChatMessage; saved: number } {
  const text = messageToText(msg);
  if (text.length < minChars) return { msg, saved: 0 };
  if (!shouldCompress(text)) return { msg, saved: 0 };
  try {
    const compressed = rtkCompress(text);
    if (!compressed || compressed.length >= text.length) {
      return { msg, saved: 0 };
    }
    return {
      msg: setMessageText(msg, compressed),
      saved: estimateTokens(text) - estimateTokens(compressed),
    };
  } catch {
    return { msg, saved: 0 };
  }
}

/** Trim oldest tool messages while preserving tool_call_id pairing. */
function trimMessages(
  messages: ChatMessage[],
  maxInputTokens: number,
  preserveTail: number
): ChatMessage[] {
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(messageToText(m)),
    0
  );
  if (totalTokens <= maxInputTokens) return messages;

  // Find tool messages we can trim (preserve the last `preserveTail` messages)
  const result = [...messages];
  const tailStart = Math.max(0, result.length - preserveTail);
  for (let i = 0; i < tailStart; i++) {
    if (result[i]!.role !== "tool") continue;
    const text = messageToText(result[i]!);
    if (text.length < 100) continue;
    result[i] = setMessageText(
      result[i]!,
      "[trimmed: tool output omitted to fit context window]"
    );
    // Check if we've trimmed enough
    const newTotal = result.reduce(
      (sum, m) => sum + estimateTokens(messageToText(m)),
      0
    );
    if (newTotal <= maxInputTokens) break;
  }
  return result;
}

/** Apply the full token saver pipeline to a request. */
export function applyTokenSaver(
  req: ChatCompletionRequest,
  settings: TokenSaverSettings,
  maxInputTokens?: number
): ApplyResult {
  const originalText = req.messages.map(messageToText).join("\n");
  const originalInputTokens = estimateTokens(originalText);

  if (!settings.enabled) {
    return {
      request: req,
      originalInputTokens,
      optimizedInputTokens: originalInputTokens,
      tokensSaved: 0,
      percentageSaved: 0,
    };
  }

  let messages = [...req.messages];

  // Pass 1: Compress tool output
  if (settings.compressToolOutput.enabled) {
    messages = messages.map((m) => {
      if (m.role !== "tool" && m.role !== "user") return m;
      const result = compressMessageContent(
        m,
        settings.compressToolOutput.minCharacterThreshold
      );
      return result.msg;
    });
  }

  // Pass 2: Inject system-prompt enhancements
  if (settings.lazySeniorDev.enabled) {
    messages = injectSystemPrompt(messages, LAZY_SENIOR_DEV_PROMPT);
  }
  if (settings.compressLlmOutput.enabled) {
    const prompt =
      settings.compressLlmOutput.mode === "ultra_terse"
        ? ULTRA_TERSE_PROMPT
        : TERSE_OUTPUT_PROMPT;
    messages = injectSystemPrompt(messages, prompt);
  }

  // Pass 3: Trim messages if over budget
  if (settings.trimMessages.enabled) {
    const budget = maxInputTokens ?? settings.trimMessages.maxInputTokens;
    messages = trimMessages(
      messages,
      budget,
      settings.trimMessages.preserveTailMessages
    );
  }

  const newText = messages.map(messageToText).join("\n");
  const optimizedInputTokens = estimateTokens(newText);
  const tokensSaved = Math.max(0, originalInputTokens - optimizedInputTokens);
  const percentageSaved =
    originalInputTokens > 0
      ? Math.round((tokensSaved / originalInputTokens) * 100)
      : 0;

  return {
    request: { ...req, messages },
    originalInputTokens,
    optimizedInputTokens,
    tokensSaved,
    percentageSaved,
  };
}
