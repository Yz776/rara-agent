/**
 * Anthropic ↔ OpenAI translator.
 *
 * Converts inbound Anthropic Messages API requests to OpenAI ChatCompletion
 * format, runs them through the shared registry pipeline, then converts
 * the OpenAI response/stream back to Anthropic format.
 *
 * This lets Claude Code, the Anthropic SDK, Zed (Anthropic mode), and
 * Cline (Anthropic mode) target this gateway directly without any
 * translation layer on their side.
 */

import crypto from "node:crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatMessage,
  ToolDefinition,
} from "../types";
import type {
  AnthropicContentBlock,
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicStreamEvent,
  AnthropicTool,
  AnthropicToolChoice,
} from "../types/anthropic";

// ── Anthropic → OpenAI ───────────────────────────────────────────────────────

/** Convert an Anthropic Messages request to an OpenAI Chat Completion request. */
export function anthropicToOpenAIRequest(req: AnthropicMessageRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // System prompt — Anthropic accepts string or array of text blocks
  if (req.system) {
    const sysText =
      typeof req.system === "string"
        ? req.system
        : req.system
            .map((b) => b.text ?? "")
            .join("\n\n");
    if (sysText) {
      messages.push({ role: "system", content: sysText });
    }
  }

  // Convert each Anthropic message to OpenAI message(s)
  for (const msg of req.messages) {
    if (msg.role === "user") {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      const parts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> = [];
      const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

      for (const block of blocks) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          });
        } else if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
              ? block.content.map((b) => b.type === "text" ? b.text : "").join("")
              : "";
          toolResults.push({
            tool_use_id: block.tool_use_id,
            content,
            is_error: block.is_error,
          });
        }
      }

      // Emit each tool result as a separate OpenAI "tool" message
      for (const tr of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        });
      }

      // If there are text/image parts, emit them as a user message
      if (parts.length > 0) {
        if (parts.length === 1 && parts[0]!.type === "text") {
          messages.push({ role: "user", content: parts[0]!.text! });
        } else {
          messages.push({ role: "user", content: parts as never });
        }
      }
    } else if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

      for (const block of blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "thinking") {
          // Map thinking blocks to reasoning_content
          textParts.push(`[thinking] ${block.thinking}`);
        }
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      messages.push(assistantMsg);
    }
  }

  // Tools
  let tools: ToolDefinition[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t: AnthropicTool) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema as never,
      },
    }));
  }

  // Tool choice
  let tool_choice: ChatCompletionRequest["tool_choice"];
  if (req.tool_choice) {
    const tc = req.tool_choice as AnthropicToolChoice;
    if (tc.type === "auto") tool_choice = "auto";
    else if (tc.type === "any") tool_choice = "required";
    else if (tc.type === "tool") tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc.type === "none") tool_choice = "none";
  }

  // Thinking — map to reasoning_effort
  let reasoning_effort: ChatCompletionRequest["reasoning_effort"];
  if (req.thinking?.type === "enabled") {
    reasoning_effort = "medium";
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop_sequences,
    tools,
    tool_choice,
    stream: req.stream,
    reasoning_effort,
    // Anthropic-specific pass-through so providers that understand it can use it
    thinking: req.thinking as never,
  };
}

// ── OpenAI → Anthropic ───────────────────────────────────────────────────────

/** Convert an OpenAI ChatCompletion response to Anthropic Message format. */
export function openAIToAnthropicResponse(
  resp: import("../types").ChatCompletionResponse,
  allowThinking = false
): AnthropicMessageResponse {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const content: AnthropicContentBlock[] = [];

  if (msg?.content) {
    content.push({ type: "text", text: msg.content });
  }

  // Tool calls → tool_use blocks
  if (msg?.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = { _raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const finish = choice?.finish_reason;
  let stop_reason: AnthropicMessageResponse["stop_reason"] = "end_turn";
  if (finish === "tool_calls") stop_reason = "tool_use";
  else if (finish === "length") stop_reason = "max_tokens";
  else if (finish === "stop") stop_reason = "end_turn";

  const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    model: resp.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens,
      cache_creation_input_tokens: 0,
    },
  };
}

// ── OpenAI stream → Anthropic stream events ──────────────────────────────────

/**
 * Convert an async iterator of OpenAI ChatCompletion chunks into Anthropic
 * streaming events.
 *
 * State machine:
 *   message_start
 *   ├─ content_block_start (text)  ← first text delta
 *   │  └─ content_block_delta (text_delta) × N
 *   │  └─ content_block_stop
 *   ├─ content_block_start (tool_use)  ← first tool_call delta
 *   │  └─ content_block_delta (input_json_delta) × N
 *   │  └─ content_block_stop
 *   └─ message_delta (stop_reason, usage)
 *   message_stop
 */
export async function* openAIToAnthropicStream(
  chunks: AsyncGenerator<ChatCompletionChunk, void, void>,
  model: string,
  options: { allowThinking?: boolean } = {}
): AsyncGenerator<AnthropicStreamEvent, void, void> {
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let started = false;

  // Track active content blocks by index (OpenAI tool_call index → Anthropic block index)
  const blockIndexByToolCallIdx = new Map<number, number>();
  const toolCallArgs = new Map<number, string>();
  let textBlockOpen = false;
  let nextBlockIndex = 0;
  let stopReason: AnthropicMessageResponse["stop_reason"] = "end_turn";

  const ensureStarted = () => {
    if (started) return;
    started = true;
  };

  for await (const chunk of chunks) {
    if (!started) {
      ensureStarted();
      yield {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
      started = true;
    }

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    // Reasoning content → thinking block
    if (options.allowThinking && delta?.reasoning_content) {
      // For simplicity, fold thinking into the text block
      // (proper thinking block handling would track a separate block)
      if (!textBlockOpen) {
        yield {
          type: "content_block_start",
          index: nextBlockIndex,
          content_block: { type: "thinking", thinking: "" },
        };
        textBlockOpen = true;
      }
      yield {
        type: "content_block_delta",
        index: nextBlockIndex,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
      };
    }

    // Text content
    if (delta?.content) {
      if (!textBlockOpen) {
        // Close any open thinking block first
        if (textBlockOpen) {
          yield { type: "content_block_stop", index: nextBlockIndex };
          nextBlockIndex++;
        }
        yield {
          type: "content_block_start",
          index: nextBlockIndex,
          content_block: { type: "text", text: "" },
        };
        textBlockOpen = true;
      }
      yield {
        type: "content_block_delta",
        index: nextBlockIndex,
        delta: { type: "text_delta", text: delta.content },
      };
    }

    // Tool calls
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!blockIndexByToolCallIdx.has(idx)) {
          // Close any open text block first
          if (textBlockOpen) {
            yield { type: "content_block_stop", index: nextBlockIndex };
            nextBlockIndex++;
            textBlockOpen = false;
          }
          const blockIdx = nextBlockIndex++;
          blockIndexByToolCallIdx.set(idx, blockIdx);
          toolCallArgs.set(idx, "");

          yield {
            type: "content_block_start",
            index: blockIdx,
            content_block: {
              type: "tool_use",
              id: tc.id ?? `toolu_${crypto.randomUUID().slice(0, 12)}`,
              name: tc.function?.name ?? "",
              input: {},
            },
          };
        }
        const blockIdx = blockIndexByToolCallIdx.get(idx)!;
        if (tc.function?.arguments) {
          const prev = toolCallArgs.get(idx) ?? "";
          toolCallArgs.set(idx, prev + tc.function.arguments);
          yield {
            type: "content_block_delta",
            index: blockIdx,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments },
          };
        }
        if (tc.function?.name && !toolCallArgs.has(idx)) {
          // Initial name in args
        }
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
      else if (choice.finish_reason === "length") stopReason = "max_tokens";
      else if (choice.finish_reason === "stop") stopReason = "end_turn";
    }
  }

  // Close any open text block
  if (textBlockOpen) {
    yield { type: "content_block_stop", index: nextBlockIndex };
  }

  // Close any open tool_use blocks
  for (const [, blockIdx] of blockIndexByToolCallIdx) {
    yield { type: "content_block_stop", index: blockIdx };
  }

  // If we never started (no chunks), emit a minimal message
  if (!started) {
    yield {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  // message_delta with stop_reason + final usage
  yield {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };

  yield { type: "message_stop" };
}
