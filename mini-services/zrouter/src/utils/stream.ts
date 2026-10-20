/**
 * SSE + upstream-stream helpers.
 *
 * These functions normalise the chaotic variety of upstream stream formats
 * (OpenAI SSE, Anthropic SSE, raw NDJSON, DeepSeek's p/v patch format) into a
 * single async iterator of JSON-parsed event objects.
 */

/** Async iterator over the non-empty trimmed lines of a Response body. */
export async function* streamLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }

  if (buffer.trim()) yield buffer.trim();
}

/** Iterator for a Node IncomingMessage (used by scrapers using node:https). */
export async function* streamNodeLines(
  stream: import("node:stream").Readable
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(
      chunk as unknown as Uint8Array,
      { stream: true }
    );
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/**
 * Strips the SSE "data:" prefix from a line.
 * Returns null for comments, keep-alive lines and the terminal [DONE] marker.
 */
export function parseDataLine(line: string): string | null {
  // Some upstreams send "event:" lines, ": comment" keep-alives, "id:" lines.
  // Only "data:" lines carry JSON payloads we care about.
  if (!line.startsWith("data:")) return null;
  const rest = line.slice(5).trim();
  if (!rest || rest === "[DONE]") return null;
  return rest;
}

/** Estimate token count using the 4-chars-per-token heuristic. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Build a random chat completion id. */
export function makeChatId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
