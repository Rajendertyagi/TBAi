import { useMemo } from "react";
import { ContextDisplayRing as StandaloneRing } from "@/components/assistant-ui/elements/context-display";
import { resolveContextWindow } from "@/config/modelContext";
import { useOpenCodeCapabilities } from "./useOpenCodeCapabilities";
import { toCodeContextUsage } from "./contextTokens";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";

/**
 * Context ring backed by the native OpenCode V2 thread state.
 *
 * ## The numerator
 *
 * `tokens.total` - OpenCode's own count of the final round trip's window - when
 * the server reports it, and only otherwise a documented `input + output`
 * derivation. Never a sum of the turn's round trips: a multi-step turn re-reads
 * the whole prompt on every call, so summing them reports a conversation as
 * several times larger than the window that actually held it.
 *
 * ## The unknown state
 *
 * A settled compaction invalidates the previous measurement, and until the next
 * usage report arrives the honest reading is no reading at all. `usage` is still
 * passed so the spend breakdown stays accurate - the tokens were really spent,
 * and the breakdown is not what went stale.
 */
export function OpenCodeContextRing() {
  const extras = useOptionalV2RuntimeExtras();
  const { models } = useOpenCodeCapabilities(true);
  const rawTokens = extras?.state.usage?.tokens;
  const contextUsage = useMemo(() => toCodeContextUsage(rawTokens), [rawTokens]);
  const stale = extras?.state.occupancyStale === true;
  if (!extras) return null;
  const current = extras.model
    ? models.find(
        (model) =>
          model.id === extras.model?.modelID &&
          model.providerID === extras.model?.providerID,
      )
    : undefined;
  return (
    <StandaloneRing
      modelContextWindow={resolveContextWindow({
        limitContext: current?.limit?.context,
      })}
      usage={contextUsage?.usage}
      contextTokens={contextUsage?.contextTokens}
      occupancyState={stale ? "unknown" : "measured"}
      resetKey={extras.sessionId}
      side="top"
    />
  );
}