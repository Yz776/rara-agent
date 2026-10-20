/**
 * /v1/chat/completions — OpenAI-compatible chat endpoint.
 *
 * Auth rules after the rewrite:
 *  - Admin API key (kr-...)  → full access (any model)
 *  - Session cookie (admin role or user role) → full access
 *  - Anonymous (no auth at all) → only when `public_free_access.enabled` is on;
 *    per-IP rate limit applies; models follow `models: 'all' | 'free'` policy
 *
 * Virtual keys are gone; the upstream credential is now sourced from the
 * per-provider key pool (services/key-pool) — see registry.chatCompletionWithPool.
 */

import { Elysia } from "elysia";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from "../types";
import * as registry from "../services/registry";
import { resolveCandidates, shouldTriggerFallback, extractStatus } from "../services/fallback";
import { resolveCombo } from "../services/combos";
import { applyTokenSaver, DEFAULT_TOKEN_SAVER_SETTINGS } from "../services/token-saver";
import { getSetting, logRequest } from "../services/db";
import {
  shouldInterceptToolCall,
  executeInterceptedToolCall,
  MAX_INTERCEPT_DEPTH,
} from "../services/tool-interceptor";
import { authenticate } from "../middleware/auth";
import { consumeAnonymousQuota, isAnonymousModelAllowed } from "../services/public-access";
import { ensureFreshToken } from "../services/token-refresh";
import { computeCost } from "../services/pricing";
import {
  getCachedResponse,
  setCachedResponse,
  recordCacheHit,
  recordCacheMiss,
} from "../services/cache";
import { isSmartRouteRequest, resolveSmartModel } from "../services/smart-router";
import { fireEvent } from "../services/webhooks";

function errPayload(message: string, status: number) {
  return {
    error: {
      message,
      type: status === 401 ? "authentication_error" : "invalid_request_error",
      code: null,
    },
  };
}

function getClientIp(ctx: { request: Request }): string {
  return (
    ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ctx.request.headers.get("cf-connecting-ip")?.trim() ??
    "unknown"
  );
}

/** Apply the full pipeline: token saver, then run chat completion. */
async function runChat(
  req: ChatCompletionRequest,
  apiKeyId: string | undefined,
  depth = 0
): Promise<{
  response: ChatCompletionResponse | null;
  stream: AsyncGenerator<ChatCompletionChunk, void, void> | null;
  fallbackPath: string[];
  fallbackReason?: string;
}> {
  // 1. Apply token saver
  const tsSettingsRaw = getSetting("token_saver", JSON.stringify(DEFAULT_TOKEN_SAVER_SETTINGS));
  let tsSettings = DEFAULT_TOKEN_SAVER_SETTINGS;
  try {
    tsSettings = { ...DEFAULT_TOKEN_SAVER_SETTINGS, ...JSON.parse(tsSettingsRaw) };
  } catch {
    /* use defaults */
  }
  const tsResult = applyTokenSaver(req, tsSettings);
  const effectiveReq = tsResult.request;

  // 2. Resolve combo/fallback candidates
  let candidates: { model: string; rule?: import("../services/config-store").FallbackRule }[] = [];
  const comboModels = resolveCombo(effectiveReq.model);
  if (comboModels) {
    candidates = comboModels.map((m) => ({ model: m }));
  } else {
    candidates = resolveCandidates(effectiveReq.model);
  }

  let lastErr: unknown = null;
  const fallbackPath: string[] = [effectiveReq.model];
  let fallbackReason: string | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const isFallback = i > 0;
    if (isFallback && candidate.rule && !shouldTriggerFallback(candidate.rule, lastErr)) {
      continue;
    }
    const currentReq: ChatCompletionRequest = { ...effectiveReq, model: candidate.model };

    try {
      // Refresh OAuth token if needed
      const providerId = candidate.model.split("/")[0] ?? "default";
      await ensureFreshToken(providerId).catch(() => undefined);

      if (currentReq.stream) {
        const gen = registry.chatCompletionStream(currentReq);
        if (isFallback) {
          fallbackPath.push(candidate.model);
        }
        return { response: null, stream: gen, fallbackPath, fallbackReason };
      } else {
        const response = await registry.chatCompletion(currentReq);

        // Tool interceptor: if response has tool_calls for interceptable tools
        if (depth < MAX_INTERCEPT_DEPTH) {
          const choice = response.choices?.[0];
          const toolCalls = choice?.message?.tool_calls;
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            const toIntercept = toolCalls.filter(
              (tc) => shouldInterceptToolCall(tc.function.name, currentReq.tools)
            );
            if (toIntercept.length > 0) {
              const updatedMessages: ChatMessage[] = [
                ...effectiveReq.messages,
                choice!.message,
              ];
              for (const tc of toIntercept) {
                const { toolCallId, result } = await executeInterceptedToolCall(tc);
                updatedMessages.push({
                  role: "tool",
                  tool_call_id: toolCallId,
                  content: JSON.stringify(result),
                });
              }
              return await runChat(
                { ...currentReq, messages: updatedMessages, stream: false },
                apiKeyId,
                depth + 1
              );
            }
          }
        }

        if (isFallback) {
          fallbackPath.push(candidate.model);
        }

        return { response, stream: null, fallbackPath, fallbackReason };
      }
    } catch (err) {
      lastErr = err;
      if (!fallbackReason) {
        fallbackReason = err instanceof Error ? err.message : String(err);
      }
      if (i === candidates.length - 1) throw err;
    }
  }
  throw lastErr ?? new Error("No providers available");
}

export const chatRoutes = new Elysia();

chatRoutes.post("/v1/chat/completions", async (ctx) => {
  console.error("[chat.ts] Route handler entered for:", ctx.body?.model);
  const body = ctx.body as ChatCompletionRequest;
  let anonymous = false;

  if (!authenticate(ctx)) {
    // Anonymous access: per-IP rate limit + model policy.
    const ip = getClientIp(ctx);
    const model = body?.model ?? "";
    if (model && isAnonymousModelAllowed(model) && consumeAnonymousQuota(ip)) {
      anonymous = true;
    } else {
      ctx.set.status = 401;
      return errPayload(
        "Invalid or missing API key. The gateway has anonymous access for select models — enable 'Public Access' in /admin.",
        401
      );
    }
  }

  if (anonymous) {
    console.log(`[chat.ts] anonymous request: ${body.model}`);
  }

  if (!body || !body.model || !Array.isArray(body.messages)) {
    ctx.set.status = 400;
    return errPayload("Missing required fields: model, messages", 400);
  }

  // Normalize "developer" → "system"
  for (const m of body.messages) {
    if (m.role === "developer") m.role = "system";
  }

  // Smart Router: resolve "smart/<strategy>" → concrete provider/model
  if (isSmartRouteRequest(body.model)) {
    try {
      const resolved = await resolveSmartModel(body.model, body);
      if (resolved) {
        console.log(`[chat.ts] Smart route: ${body.model} → ${resolved}`);
        body.model = resolved;
      }
    } catch (e) {
      console.error("[chat.ts] Smart route resolution failed:", e);
    }
  }

  const startTime = Date.now();

  // Cache check (non-streaming only — streaming defeats cache purpose)
  if (!body.stream) {
    const cached = getCachedResponse(body);
    if (cached) {
      recordCacheHit();
      console.log("[chat.ts] Cache HIT for model:", body.model);
      const latencyMs = Date.now() - startTime;
      const providerId = body.model.split("/")[0] ?? "default";
      logRequest({
        id: `req-${crypto.randomUUID()}`,
        apiKeyId: anonymous ? "anonymous" : undefined,
        providerId,
        model: body.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        statusCode: 200,
        latencyMs,
        estimatedCost: 0,
        fallbackOccurred: false,
        fallbackReason: "cache-hit",
      });
      return cached.response as ChatCompletionResponse;
    }
    recordCacheMiss();
  }

  try {
    const result = await runChat(body, undefined);
    const providerId = body.model.split("/")[0] ?? "default";

    if (result.stream) {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (obj: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          let totalCompletionTokens = 0;
          let lastUsage:
            | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            | undefined;
          try {
            for await (const chunk of result.stream as AsyncGenerator<ChatCompletionChunk>) {
              if (chunk.usage) {
                lastUsage = chunk.usage;
                totalCompletionTokens = chunk.usage.completion_tokens ?? 0;
              }
              if (chunk === "[DONE]" || (typeof chunk === "string" && chunk === "[DONE]")) {
                continue;
              }
              send(chunk);
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send({ error: { message: msg, type: "upstream_error" } });
          } finally {
            controller.close();
            const latencyMs = Date.now() - startTime;
            const promptTokens = lastUsage?.prompt_tokens ?? 0;
            const completionTokens = lastUsage?.completion_tokens ?? 0;
            const totalTokens = lastUsage?.total_tokens ?? 0;
            const cost = computeCost(body.model, promptTokens, completionTokens);
            logRequest({
              id: `req-${crypto.randomUUID()}`,
              apiKeyId: anonymous ? "anonymous" : undefined,
              providerId,
              model: body.model,
              promptTokens,
              completionTokens,
              totalTokens,
              statusCode: 200,
              latencyMs,
              estimatedCost: cost,
              fallbackOccurred: result.fallbackPath.length > 1,
              fallbackPath:
                result.fallbackPath.length > 1 ? result.fallbackPath.join(" -> ") : undefined,
              fallbackReason: result.fallbackReason,
            });
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
      const resp = result.response!;
      const usage = resp.usage;
      const latencyMs = Date.now() - startTime;
      const promptTokens = usage?.prompt_tokens ?? 0;
      const completionTokens = usage?.completion_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? 0;
      const cost = computeCost(body.model, promptTokens, completionTokens);
      logRequest({
        id: `req-${crypto.randomUUID()}`,
        apiKeyId: anonymous ? "anonymous" : undefined,
        providerId,
        model: body.model,
        promptTokens,
        completionTokens,
        totalTokens,
        statusCode: 200,
        latencyMs,
        estimatedCost: cost,
        fallbackOccurred: result.fallbackPath.length > 1,
        fallbackPath:
          result.fallbackPath.length > 1 ? result.fallbackPath.join(" -> ") : undefined,
        fallbackReason: result.fallbackReason,
      });
      // Cache the response (non-streaming only)
      setCachedResponse(body, resp);
      return resp;
    }
  } catch (err) {
    console.error("[chat.ts] Caught error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    const status = extractStatus(err);
    const latencyMs = Date.now() - startTime;
    const providerId = body.model.split("/")[0] ?? "default";
    logRequest({
      id: `req-${crypto.randomUUID()}`,
      apiKeyId: anonymous ? "anonymous" : undefined,
      providerId,
      model: body.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      statusCode: status ?? 502,
      latencyMs,
      estimatedCost: 0,
      fallbackOccurred: false,
      fallbackReason: msg,
    });
    ctx.set.status = status && status >= 400 && status < 600 ? status : 502;
    return errPayload(msg, ctx.set.status);
  }
});
