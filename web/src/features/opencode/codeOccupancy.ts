/**
 * What the context window holds RIGHT NOW, derived from persisted messages.
 *
 * ## Why this exists
 *
 * `state.usage` is the SESSION's token ledger. OpenCode accumulates into it for
 * every step of every turn, so it is cumulative TRAFFIC, not occupancy. Measured
 * live against opencode 2.0.22 through TBAi's own Code path, three trivial turns
 * produced session totals of 12,451 -> 24,005 -> 35,571 while the newest
 * assistant response stayed flat at 11,524. Reading the ledger as the ring
 * numerator therefore reports the sum of every round trip ever made, which is
 * exactly the failure the meter exists to avoid: at a 200K window it reads 100%
 * after roughly 17 short turns while the model is actually holding ~12K.
 *
 * OpenChamber does not have this problem because it never reads the session
 * ledger for occupancy. `findLatestContextFill` walks the MESSAGE list backwards
 * and takes the newest assistant response that reported tokens
 * (`packages/ui/src/stores/utils/tokenUtils.ts`). This module is that rule,
 * expressed over OpenCode v2's `SessionMessageInfo` union.
 *
 * ## The compaction rule
 *
 * A finished compaction makes the fill UNKNOWN rather than zero, because the
 * conversation the last measurement described no longer exists. A compaction
 * still running, or one that failed, changed nothing and is skipped so the
 * previous reading stands. OpenCode v2 records a compaction as its own
 * `type: "compaction"` message carrying `status`, so "finished" is an exact
 * `status === "completed"` with no error - not a heuristic over summary text.
 */

import type { SessionMessageInfo, TokenUsageInfo } from "@opencode/client";
import { toCodeContextUsage } from "./contextTokens";

/**
 * The current fill, or `null` when no message in the list can say.
 *
 * `unknown` is a real answer, not a missing one: it means a compaction settled
 * and nothing trustworthy has been reported since.
 */
export type CodeOccupancy =
  | { readonly state: "measured"; readonly tokens: TokenUsageInfo }
  | { readonly state: "unknown" };

/**
 * True for a compaction record that finished successfully.
 *
 * `status` alone is the whole test: OpenCode's v2 union types `completed` without
 * an `error` field and `failed` with one, so a completed record cannot carry a
 * failure. OpenChamber additionally checks `!error` against a looser shape.
 */
function isFinishedCompaction(message: SessionMessageInfo): boolean {
  return message.type === "compaction" && message.status === "completed";
}

/**
 * The current context fill for a session, newest message first.
 *
 * @param messages Persisted session messages in chronological order.
 * @returns The measured fill, `unknown` after a settled compaction, or `null`
 *   when no message reports tokens.
 */
export function resolveCodeOccupancy(
  messages: readonly SessionMessageInfo[],
): CodeOccupancy | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;

    // A finished compaction invalidates everything measured before it. A running
    // or failed one is skipped, so the previous reading survives it.
    if (message.type === "compaction") {
      if (isFinishedCompaction(message)) return { state: "unknown" };
      continue;
    }

    if (message.type !== "assistant") continue;
    // Reuse the single validator/summer so the wire-shape guard and the
    // `total`-preferring rule cannot drift between this path and the ring.
    const usage = toCodeContextUsage(message.tokens);
    if (usage?.contextTokens !== undefined && usage.contextTokens > 0) {
      return { state: "measured", tokens: message.tokens as TokenUsageInfo };
    }
  }
  return null;
}

/** The occupancy payload to render, or `undefined` while it is unknown. */
export function occupancyTokens(occupancy: CodeOccupancy | null): TokenUsageInfo | undefined {
  return occupancy?.state === "measured" ? occupancy.tokens : undefined;
}
