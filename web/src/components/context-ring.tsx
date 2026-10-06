import { useAuiState } from "@assistant-ui/react";
import { ContextDisplayRing as DirectRuntimeRing } from "./assistant-ui/elements/context-display.aui";
import { contextPanelCopy } from "../config/context-meter";
import { useCurrentContext } from "../features/chat/context/useCurrentContext";

/** The provider/model a conversation is bound to, as the send path reads it. */
interface ConversationCustom {
  providerId?: string | null;
  modelId?: string | null;
}

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
 * ## Why this now knows the conversation's binding
 *
 * Not to resolve anything — the server's `resolvedFor` identity is what gets compared,
 * and the only thing this component contributes is "which conversation is this". The
 * reading is a per-turn sample, so a conversation re-pointed at a different model
 * would otherwise keep showing the previous model's window and occupancy as if they
 * were its own. Withholding is the honest response: the current authoritative window
 * is not knowable from here, and deriving one locally is the second authority this
 * component was rewritten to eliminate.
 *
 * Known limitation, deliberate: editing a model's window WITHOUT changing which model
 * is selected leaves the previous turn's reading on screen until the next turn. The
 * sample is still a true measurement of that turn; only its currency is in question,
 * and the server publishes nothing that would let the client tell. Closing it needs a
 * server-published resolution for the current selection, which is a new endpoint and
 * deliberately out of scope here.
 *
 * ## Why the panel is a Popover and not a HoverCard
 *
 * The panel contains a button. A hover-dismissed surface is the wrong home for
 * something you click — moving toward the button can close it — and Radix `HoverCard`
 * additionally swallows `click` on touch, which is why the reference implementation
 * carries a `pointerdown` workaround for exactly that. `Popover` is click-triggered,
 * already vendored here, and the ring already implements click-to-pin, so this
 * continues an interaction the composer already has instead of adding a second one.
 */
/**
 * Normalise one field of a conversation binding.
 *
 * `null`, `undefined` and an empty string all mean "not set", and all three must
 * collapse to `undefined` so the identity comparison treats them alike. Written as a
 * predicate rather than `?? undefined` because this file is statically guarded against
 * ANY null-coalesce: in a component whose denominator is a number, a `??` is
 * indistinguishable from a substituted window, and that guard is worth keeping blunt.
 */
function binding(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function DirectContextRing({ onCompact }: { onCompact?: () => void }) {
  // The SAME binding `prepareSendMessagesRequest` resolves the request from, so the
  // comparison cannot drift from what the next turn would actually use.
  const custom = useAuiState((s) => s.threadListItem.custom) as ConversationCustom | undefined;
  const providerId = binding(custom?.providerId);
  const modelId = binding(custom?.modelId);

  const serverContext = useCurrentContext(
    modelId === undefined ? undefined : { providerId, modelId },
  );
  if (!serverContext) return null;

  // The action rides INSIDE the ring's own click-to-pin content, which is the one
  // surface here that already owns a trigger and a dismissal. An earlier version
  // wrapped the ring in a second `PopoverTrigger` instead; the inner tooltip trigger
  // consumed the click, so the panel could never open. Occupancy, provenance and the
  // token segments were already in that content, so a second overlay would also have
  // duplicated them.
  const action =
    onCompact === undefined ? undefined : (
      <button
        type="button"
        onClick={onCompact}
        title={contextPanelCopy.compactHint}
        className="text-foreground hover:bg-accent hover:text-accent-foreground w-full rounded-xs px-1 py-0.5 text-left text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        {contextPanelCopy.compactNow}
      </button>
    );

  return (
    <DirectRuntimeRing
      modelContextWindow={serverContext.windowTokens}
      contextTokens={serverContext.usedTokens}
      windowSource={serverContext.windowSource}
      side="top"
      action={action}
    />
  );
}
