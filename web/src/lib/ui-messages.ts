/**
 * Reading plain text out of an assistant-ui thread's messages.
 *
 * Extracted rather than written twice: the runtime needs the last user turn to
 * hand off an OpenCode draft's first prompt, and the Composer's retry affordance
 * needs the same turn to re-send. One implementation, one definition of "the
 * text a user actually typed".
 *
 * Defensive by design — these run against runtime state that is mid-hydration,
 * so every field is checked rather than trusted.
 */

type UIMessageLike = {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

/** Plain text of the last user message, or null when there is none. */
export function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as UIMessageLike;
    if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
    const text = message.parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    if (text) return text;
  }
  return null;
}
