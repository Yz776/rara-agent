// ─────────────────────────────────────────────────────────────────────────────
// Rara — MCP stub (zrouter removed)
// ─────────────────────────────────────────────────────────────────────────────
// rara-agent no longer bundles zrouter, so there is no MCP server to call.
// The krouter_* admin tools (krouter_status, krouter_usage, krouter_fetch,
// etc.) are kept in the tool list for backward-compat with the system prompt
// but they now return a graceful "not available" message instead of crashing.
// All upstream AI calls go directly to https://opencode.ai via the bundled
// opencode client (src/lib/opencode/client.ts).

type MCPResult = {
  ok: boolean;
  text?: string;
  error?: string;
};

export async function callMcpTool(_name: string, _args: Record<string, unknown> = {}): Promise<MCPResult> {
  return {
    ok: false,
    error:
      "krouter_* tools are not available — rara-agent no longer bundles zrouter. " +
      "Use http_fetch (direct fetch) or web_search / google_search instead. " +
      "The AI gateway is now built directly into rara-agent (opencode.ai free-tier).",
  };
}
