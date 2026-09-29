import { Component, type ErrorInfo, type ReactNode } from "react";
import { useAuiState, useToolCallElapsed } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

/**
 * The wall-clock time a tool call took, in OpenChamber's `1.4s` form.
 *
 * ## This is the library primitive, not a timer
 *
 * assistant-ui ships `useToolCallElapsed`, which reads the part's own recorded
 * timing and ticks once per second while the call runs. TBAi was not using it,
 * so the obvious implementation here was a `setInterval` + `Date.now()` in a
 * `useEffect`. That would be a second source of truth for "how long did this
 * take", measuring wall-clock from mount — which differs from the duration the
 * runtime actually recorded, and keeps counting for calls that already
 * finished. The hook returns the runtime's own number.
 *
 * It also documents the exact format used here: `{(elapsedMs / 1000).toFixed(1)}s`.
 *
 * ## Why the boundary below exists — an upstream gap, worked around
 *
 * The hook's docblock promises it returns `undefined` "when no message part
 * scope is available (so kit components stay renderable standalone, e.g. in
 * docs previews)". It does not. Its selector is
 * `s => s.optional.part.timing`, and outside a part scope `s.optional` is
 * `undefined` rather than an empty scope, so the read throws
 * (`TypeError: undefined is not an object`).
 *
 * TBAi's tool renderers ARE rendered standalone — `websearch.test.tsx` and the
 * other render tests mount them bare with `react-dom/server`, with no
 * `AuiProvider`. Mounting this badge directly broke five of them. The boundary
 * restores the behaviour the hook documents, by rendering nothing when the
 * scope is missing. It is the sanctioned React mechanism for isolating a
 * component that may be mounted outside the context it needs, and it keeps the
 * library hook rather than replacing it with a hand-rolled timer.
 *
 * Remove the boundary when upstream's `useToolCallElapsed` guards its own
 * selector; the badge above it needs no change.
 *
 * ## Where this actually renders today, and where it does not
 *
 * The hook reads `part.timing`, so the badge appears wherever the runtime
 * records it:
 *
 * - **Direct chat: yes.** That surface is `useChatRuntime` +
 *   `AssistantChatTransport` (`web/src/runtime.ts:436,316`), and the AI SDK
 *   transport records timing on tool-call parts.
 * - **Code (OpenCode): NO, and deliberately so.** That surface is
 *   `useExternalStoreRuntime` over TBAi's own adapter
 *   (`features/opencode/v2Runtime.tsx:25`), and `v2MessageProjection.ts` never
 *   sets `timing` on a tool part. So the hook returns `undefined` there and the
 *   badge is absent — which is the honest outcome, not a silent zero.
 *
 * Making Code mode show it means the projection has to derive `startedAt` /
 * `completedAt` from the `session.tool.*` event timestamps and put them on the
 * projected part. That is app code feeding a library read, which is the right
 * layering, but it is a separate change and is NOT done here — so this file's
 * tests do not claim Code mode works.
 *
 * ## The three presentation decisions, and why
 *
 * 1. **`tabular-nums`.** Non-negotiable, and the one thing easy to miss. The
 *    value ticks while the call runs, so a proportional digit width makes the
 *    number physically shove its neighbours around once a second. Tabular
 *    figures give every digit the same width, so the row does not move. The
 *    same reasoning is why the vendored `session-timeline` uses it.
 * 2. **Right-aligned, muted, `text-xs`.** It is metadata about the card, not
 *    part of what the card says, so it takes the existing muted token at the
 *    existing small size and sits on the trailing edge. No new token, no new
 *    size, no new colour.
 * 3. **Renders nothing when there is no duration.** The hook returns
 *    `undefined` for a part with no timing or one that ended without a recorded
 *    completion. A placeholder would put "0.0s" on every card whose timing the
 *    runtime did not capture, which is a number about nothing.
 */

/** Renders nothing in place of a child that threw, so the card still paints. */
class ElapsedBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  public state = { failed: false };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /** Swallowed deliberately: the fallback IS the handled case. */
  public componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  public render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Whether a message part scope exists at this render position.
 *
 * `s.optional` is a scope the tap runtime registers per render position. Inside
 * a real message part it holds the part; in a bare `renderToStaticMarkup` it is
 * simply `undefined`, which is what makes `useToolCallElapsed` throw.
 *
 * The read is null-safe on purpose — `?.` rather than a throw-and-catch — so it
 * is a cheap, total read of a scope that is legitimately absent. Returning
 * `false` here is what lets the caller render the hook only where it can work.
 */
function useHasPartScope(): boolean {
  return useAuiState((state) => (state as { optional?: { part?: unknown } }).optional?.part != null);
}

/**
 * Formats a duration for the badge, in three ranges.
 *
 * ## Why this exists
 *
 * The library documents one format, `{(elapsedMs / 1000).toFixed(1)}s`, and this
 * file used exactly that. It is right for the case it was written for — a tool
 * call that takes a moment — and wrong for anything longer. A real failed
 * `shell` call rendered `3618.8s`, which is a number no reader can parse at a
 * glance, on a card whose whole purpose is to be scanned.
 *
 * OpenChamber has the same line and the same problem (`ToolPart.tsx:126`,
 * `MessageBody.tsx:206`, `telemetry.ts:83`), so there was no reference to copy
 * and the shape below is a decision, not a port.
 *
 * | Range | Form | Why |
 * |---|---|---|
 * | under a minute | `12.3s` | the library's own form, and the case it is good at |
 * | under an hour | `2m 14s` | the two units a reader actually compares against |
 * | an hour and up | `1h 03m` | seconds stop mattering at this scale, so they are dropped |
 *
 * Seconds are dropped past an hour rather than shown, because `1h 00m 03s` is
 * three units of noise for the same fact as `1h 00m`, and the minute is
 * zero-padded so the width does not jump between values.
 *
 * ## Why not a library
 *
 * `Intl.DurationFormat` is the platform answer and is not used, for two
 * reasons. It is unavailable or inconsistent across the browsers this app
 * targets, and its default output is verbose for a badge — it spells out
 * "1 hour, 2 minutes" rather than the compact form a card can afford. The whole
 * rule is three branches; a dependency or a polyfill would be more code and more
 * risk than the function it replaces.
 *
 * @param ms - Elapsed milliseconds. Non-finite or negative values read as zero.
 * @returns A compact, human-comparable duration.
 */
export function formatDuration(ms: number): string {
  // Sanitise once, up front. `Math.max(NaN, 0)` is still `NaN`, so clamping at
  // the point of use renders "NaNs" — a badge that looks like a bug in the card.
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) {
    return `${(safe / 1000).toFixed(1)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/**
 * The duration badge, safe to mount outside a message part.
 *
 * The library hook is the source of truth; this only decides whether it can be
 * called at all. The boundary is a second line of defence for a client render
 * where the scope is present but the part is not a tool call, which is the case
 * the hook documents as returning `undefined`.
 *
 * @returns The formatted duration, or null when the call carries no timing or
 *   no part scope is available.
 */
export function ToolElapsed({ className }: { className?: string }) {
  const hasPartScope = useHasPartScope();
  if (!hasPartScope) return null;
  return (
    <ElapsedBoundary>
      <ElapsedValue className={className} />
    </ElapsedBoundary>
  );
}

/** Reads the runtime's own timing. Must only mount inside a part scope. */
function ElapsedValue({ className }: { className?: string }) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums text-muted-foreground",
        className,
      )}
    >
      {formatDuration(elapsedMs)}
    </span>
  );
}
