/**
 * /v1/messages — Anthropic-compatible Messages API.
 *
 * Accepts the standard Anthropic Messages request body. Translates it to
 * OpenAI ChatCompletion format, runs through the shared registry pipeline
 * (which applies fallback rules, token saver, etc.), then translates the
 * response back to Anthropic format.
 *
 * Streaming: when `stream: true`, emits Anthropic SSE events:
 *   event: message_start
 *   event: content_block_start
 *   event: content_block_delta
 *   event: content_block_stop
 *   event: message_delta
 *   event: message_stop
 *
 * Each line is `event: <type>\ndata: <json>\n\n`.
 */

import { Elysia } from "elysia";
import type { AnthropicMessageRequest } from "../types/anthropic";
import type { ChatCompletionRequest } from "../types";
import * as registry from "../services/registry";
import { resolveCandidates, shouldTriggerFallback, extractStatus } from "../services/fallback";
import { anthropicToOpenAIRequest, openAIToAnthropicResponse, openAIToAnthropicStream } from "../services/translator";
import { authenticate } from "../middleware/auth";

function errPayload(type: string, message: string) {
  return {
    type: "error",
    error: { type, message },
  };
}

export const messagesRoutes = new Elysia();

messagesRoutes.post("/v1/messages", async (ctx) => {
  if (!authenticate(ctx)) {
    ctx.set.status = 401;
    return errPayload("authentication_error", "Invalid or missing API key. Generate one at /admin");
  }

  const body = ctx.body as AnthropicMessageRequest;
  if (!body || !body.model || !Array.isArray(body.messages)) {
    ctx.set.status = 400;
    return errPayload("invalid_request_error", "Missing required fields: model, messages");
  }
  if (typeof body.max_tokens !== "number" || body.max_tokens <= 0) {
    ctx.set.status = 400;
    return errPayload("invalid_request_error", "max_tokens is required and must be > 0");
  }

  const allowThinking = body.thinking?.type === "enabled";

  // Translate to OpenAI ChatCompletion request
  const openaiReq: ChatCompletionRequest = anthropicToOpenAIRequest(body);

  const candidates = resolveCandidates(openaiReq.model);
  let lastErr: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const isFallback = i > 0;
    if (isFallback && candidate.rule && !shouldTriggerFallback(candidate.rule, lastErr)) {
      continue;
    }
    const req: ChatCompletionRequest = { ...openaiReq, model: candidate.model };

    try {
      if (body.stream) {
        // Stream Anthropic SSE events
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            const send = (ev: { type: string }) => {
              controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
            };
            try {
              const gen = registry.chatCompletionStream(req);
              const anthropicStream = openAIToAnthropicStream(gen, body.model, { allowThinking });
              for await (const ev of anthropicStream) {
                send(ev);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              send({ type: "error", error: { type: "upstream_error", message: msg } });
            } finally {
              controller.close();
            }
          },
        });

        ctx.set.headers["Content-Type"] = "text/event-stream";
        ctx.set.headers["Cache-Control"] = "no-cache";
        ctx.set.headers["Connection"] = "keep-alive";
        ctx.set.headers["X-Accel-Buffering"] = "no";
        return new Response(stream, {
          headers: ctx.set.headers as Record<string, string>,
        });
      } else {
        const resp = await registry.chatCompletion(req);
        return openAIToAnthropicResponse(resp, allowThinking);
      }
    } catch (err) {
      lastErr = err;
      const status = extractStatus(err);
      if (i === candidates.length - 1) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.set.status = status && status >= 400 && status < 600 ? status : 502;
        const errType =
          ctx.set.status === 401 || ctx.set.status === 403 ? "authentication_error" :
          ctx.set.status === 429 ? "rate_limit_error" :
          ctx.set.status >= 500 ? "api_error" : "invalid_request_error";
        return errPayload(errType, msg);
      }
    }
  }

  ctx.set.status = 500;
  return errPayload("api_error", "No providers available");
});
