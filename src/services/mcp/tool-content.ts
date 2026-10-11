/**
 * Text shaping for MCP sampling/prompt content.
 *
 * Extracted verbatim from `manager.ts`. These two functions are the boundary
 * between the MCP wire shape (nested content blocks) and the plain string that
 * becomes model input or a log message.
 *
 * ## Why they are their own module
 *
 * They are pure, total, and have no dependency on a connection — which is what
 * makes `getAiTools` delegable without exporting the connection map. A resource
 * block is JSON-stringified rather than dropped, so an image or blob returned by
 * a tool still reaches the model as something inspectable instead of vanishing.
 */

/** Best-effort text extraction from a v2 sampling/prompt message content block. */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const item = c as { type?: string; text?: string };
          if (item.type === "text") return item.text ?? "";
          return "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const item = content as { type?: string; text?: string };
    if (typeof item.text === "string") return item.text;
  }
  return "";
}

/** Flatten a tool result's content blocks into one string for the model. */
export function mcpContentToText(res: unknown): string {
  const content = (res as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const item = c as { type?: string; text?: string; resource?: unknown; [k: string]: unknown };
        if (item.type === "text") return item.text ?? "";
        if (item.type === "resource") return JSON.stringify(item.resource ?? item);
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (res && typeof res === "object") return JSON.stringify(res);
  return String(res ?? "");
}