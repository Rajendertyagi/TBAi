import { ContextDisplayRing as DirectRuntimeRing } from "./assistant-ui/elements/context-display.aui";
import { useCurrentContext } from "../features/chat/context/useCurrentContext";

/**
 * Direct-chat context ring for the composer rail.
 *
 * ## The server is the only authority for the denominator
 *
 * Both halves of this meter come from the server's resolution:
 *
 *  - the NUMERATOR is the provider's own count of the prompt for the last model call
 *    (`useCurrentContext`, fed by the route's `messageMetadata.context`);
 *  - the DENOMINATOR is the effective window the server resolved from that same
 *    budget it enforces, carried alongside its provenance in `windowSource`.
 *
 * This component used to fall back to a frontend-side `resolveContextWindow` with its
 * own precedence and its own 128k default. That made a second authority for the same
 * number, and it could contradict the budget the request was actually measured
 * against — including while reporting no provenance, so the ring could display
 * "… / 128k" next to the words "Context limit unknown".
 *
 * Now the fallback is gone. Before the server publishes a reading the ring renders
 * NOTHING, which is the honest state: a meter with no authoritative denominator has
 * nothing truthful to say. There is no placeholder and no local estimate, and the
 * displayed denominator is by construction the same value the budget used.
 *
 * The model/provider plumbing that fed the old fallback was removed with it — the ring
 * no longer needs to know which model is selected, because it does not resolve the
 * window. Model identity belongs to the server's resolution result, which already
 * carries it.
 */
export function DirectContextRing() {
  const serverContext = useCurrentContext();
  if (!serverContext) return null;
  return (
    <DirectRuntimeRing
      modelContextWindow={serverContext.windowTokens}
      contextTokens={serverContext.usedTokens}
      windowSource={serverContext.windowSource}
      side="top"
    />
  );
}
