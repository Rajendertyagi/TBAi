/**
 * TBAi-specific glue on top of the official assistant-ui rendering elements.
 * Kept intentionally tiny — everything else is verbatim registry code.
 */

/**
 * MCP tools are exposed as `mcp__<serverId>__<toolName>`. Present them as
 * "server · tool" so the UI stays readable; other tool names pass through.
 */
export function prettyToolName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return toolName;
  return `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
}
