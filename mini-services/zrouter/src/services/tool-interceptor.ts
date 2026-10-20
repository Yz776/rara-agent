/**
 * Tool interceptor — intercepts tool calls for web search / web fetch when
 * the client did NOT declare those tools in their request.
 *
 * This lets agents get live web search results without a separate round-trip.
 *
 * The interceptor:
 * 1. Listens to streaming tool_calls from the upstream model
 * 2. If the tool name matches `web_search` / `google_search` / `brave_search` /
 *    `web_fetch` and the client didn't declare it:
 *    - Executes the search server-side
 *    - Appends the result as a `tool` message
 *    - Re-invokes the model with depth+1 (max depth 3)
 * 3. Otherwise, passes the tool_call through unchanged
 *
 * Currently we use a simple DuckDuckGo HTML scrape for search — no API key
 * required.
 */

import type { ChatCompletionRequest, ToolCall } from "../types";

const MAX_INTERCEPT_DEPTH = 3;

const SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "web_search_preview",
  "search",
  "google_search",
  "duckduckgo_search",
  "brave_search",
  "bing_search",
]);

const FETCH_TOOL_NAMES = new Set([
  "web_fetch",
  "fetch_url",
  "get_url",
  "browse",
  "fetch",
]);

export function shouldInterceptToolCall(
  toolName: string,
  clientTools?: ChatCompletionRequest["tools"]
): boolean {
  const normalized = toolName.toLowerCase().trim();
  if (!SEARCH_TOOL_NAMES.has(normalized) && !FETCH_TOOL_NAMES.has(normalized)) {
    return false;
  }
  // Only intercept if the client did NOT declare this tool
  if (!clientTools || clientTools.length === 0) return true;
  return !clientTools.some((t) => t.function.name === toolName);
}

export function extractSearchQuery(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const obj = args as Record<string, unknown>;
    return (
      (obj.query as string) ??
      (obj.q as string) ??
      (obj.search_query as string) ??
      (obj.searchTerm as string) ??
      (obj.search as string) ??
      (obj.keyword as string) ??
      (obj.text as string) ??
      ""
    );
  }
  return "";
}

export function extractFetchUrl(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const obj = args as Record<string, unknown>;
    return (
      (obj.url as string) ??
      (obj.link as string) ??
      (obj.href as string) ??
      (obj.address as string) ??
      ""
    );
  }
  return "";
}

/** Run a web search using DuckDuckGo HTML endpoint (no API key required). */
export async function executeWebSearch(query: string): Promise<{
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}> {
  if (!query) return { query: "", results: [] };
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return { query, results: [] };
    const html = await res.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    // Parse DuckDuckGo HTML results
    const matches = html.matchAll(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    );
    for (const match of matches) {
      if (results.length >= 8) break;
      const [, urlRaw, title, snippetRaw] = match;
      // Decode DDG redirect URL
      const decoded = urlRaw?.startsWith("//duckduckgo.com/l/?uddg=")
        ? decodeURIComponent(urlRaw.slice("//duckduckgo.com/l/?uddg=".length).split("&")[0]!)
        : urlRaw;
      const snippet = snippetRaw?.replace(/<[^>]+>/g, "").trim() ?? "";
      results.push({
        title: title?.trim() ?? "",
        url: decoded ?? "",
        snippet,
      });
    }
    return { query, results };
  } catch (err) {
    console.error("[webSearch] failed:", err);
    return { query, results: [] };
  }
}

/** Fetch a URL and return its text content (truncated to ~8K chars). */
export async function executeWebFetch(url: string): Promise<{
  url: string;
  title: string;
  content: string;
  truncated: boolean;
}> {
  if (!url) return { url: "", title: "", content: "", truncated: false };
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html,application/json,text/plain",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { url, title: "", content: `HTTP ${res.status} ${res.statusText}`, truncated: false };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let title = "";
    let content = text;
    if (contentType.includes("text/html")) {
      const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      title = titleMatch?.[1]?.trim() ?? "";
      // Strip HTML tags
      content = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } else if (contentType.includes("application/json")) {
      title = "JSON";
      // Pretty-print if possible
      try {
        content = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        content = text;
      }
    }
    const MAX = 8000;
    const truncated = content.length > MAX;
    if (truncated) content = content.slice(0, MAX) + "\n[... truncated]";
    return { url, title, content, truncated };
  } catch (err) {
    return {
      url,
      title: "",
      content: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      truncated: false,
    };
  }
}

/** Execute an intercepted tool call. */
export async function executeInterceptedToolCall(
  toolCall: ToolCall
): Promise<{ toolCallId: string; result: unknown }> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    args = { _raw: toolCall.function.arguments };
  }
  const name = toolCall.function.name.toLowerCase().trim();

  if (SEARCH_TOOL_NAMES.has(name)) {
    const query = extractSearchQuery(args);
    const result = await executeWebSearch(query);
    return { toolCallId: toolCall.id, result };
  }
  if (FETCH_TOOL_NAMES.has(name)) {
    const url = extractFetchUrl(args);
    const result = await executeWebFetch(url);
    return { toolCallId: toolCall.id, result };
  }
  return { toolCallId: toolCall.id, result: { error: "Unknown intercepted tool" } };
}

export { MAX_INTERCEPT_DEPTH };
