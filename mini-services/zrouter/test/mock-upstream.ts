/**
 * Mock upstream OpenAI server — for verifying the gateway's streaming
 * output is bit-perfect OpenAI-compatible.
 *
 * Run separately: bun run test/mock-upstream.ts
 * Listens on :4123, returns a 3-token streaming response.
 */

import { Elysia } from "elysia";

const app = new Elysia()
  .get("/v1/models", () => ({
    object: "list",
    data: [
      { id: "mock-llama", object: "model", owned_by: "mock" },
      { id: "mock-gpt", object: "model", owned_by: "mock" },
    ],
  }))
  .post("/v1/chat/completions", (ctx) => {
    const body = ctx.body as { stream?: boolean; model?: string; messages?: Array<{ content: string }> };
    const id = `chatcmpl-mock-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const userMsg = body?.messages?.[0]?.content ?? "Hello";
    const reply = `Mock reply to: ${userMsg}`;

    if (!body?.stream) {
      return {
        id,
        object: "chat.completion",
        created,
        model: body?.model ?? "mock-llama",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(userMsg.length / 4),
          completion_tokens: Math.ceil(reply.length / 4),
          total_tokens: Math.ceil((userMsg.length + reply.length) / 4),
        },
      };
    }

    // Streaming
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // First chunk: role
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: body?.model ?? "mock-llama",
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            })}\n\n`
          )
        );
        // Token chunks
        const tokens = reply.split(" ");
        for (const tok of tokens) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: body?.model ?? "mock-llama",
                choices: [{ index: 0, delta: { content: tok + " " }, finish_reason: null }],
              })}\n\n`
            )
          );
        }
        // Final chunk: finish_reason + usage
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: body?.model ?? "mock-llama",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: Math.ceil(userMsg.length / 4),
                completion_tokens: Math.ceil(reply.length / 4),
                total_tokens: Math.ceil((userMsg.length + reply.length) / 4),
              },
            })}\n\n`
          )
        );
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  })
  .post("/v1/embeddings", (ctx) => {
    const body = ctx.body as { input?: string | string[]; model?: string };
    const input = body?.input ?? "";
    const inputs = Array.isArray(input) ? input : [input];
    // Generate deterministic fake embeddings (1536-dim like OpenAI text-embedding-3-small)
    const data = inputs.map((text, i) => {
      const embedding = new Array(1536).fill(0).map((_, j) => {
        // Deterministic pseudo-random based on text + index
        const seed = (text.charCodeAt(i % text.length) || 0) + j;
        return Math.sin(seed) * 0.1;
      });
      return { object: "embedding", index: i, embedding };
    });
    const promptTokens = inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return {
      object: "list",
      data,
      model: body?.model ?? "mock-llama",
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
  })
  .listen(4123);

console.log("Mock upstream listening on http://localhost:4123");
