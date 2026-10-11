/**
 * SPIKE — shared window/message shapes for the scroll harness. TEMPORARY.
 *
 * Split out of `proof-harness.ts` because that module imports
 * `tests-dom/harness/resolve` (node:module + `file://` imports), which cannot be
 * bundled for a browser. The shapes are the same — this file carries no logic.
 */

export type AiMsg = {
  id: string;
  role: "user" | "assistant";
  parts: Array<Record<string, unknown>>;
};

/** A contiguous user/assistant chain m{from}..m{to}. */
export const chainFromTo = (from: number, to: number): AiMsg[] =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return {
      id: `m${n}`,
      role: (n % 2 === 1 ? "user" : "assistant") as "user" | "assistant",
      parts: [{ type: "text", text: `body m${n}` }],
    };
  });
