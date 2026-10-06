"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { isPlainEnter, isPlainEscape } from "@/lib/ime";
import {
  focusComposerInput,
  isDecisionSurfaceOwner,
  registerDecisionSurface,
  useDecisionSurfaceFocus,
} from "@/lib/focus";

/**
 * The card surface both decision states share: the open gate
 * ({@link ApprovalCard}) and the decided row ({@link CollapsedDecisionRow}).
 * One class list, so a card cannot look one way while it is asking for a
 * decision and another way once it has one. Both colour steps are theme
 * tokens (`--card-soft`, `--card-outline` in `globals.css`), never literals.
 *
 * Exported so any TBAi-owned surface that waits on the reader uses this exact
 * treatment rather than restating the classes — the OpenCode question dock is
 * the other owner. Restating it is how two cards drift apart.
 */
export const CARD_SURFACE = "rounded-2xl bg-card-soft ring-1 ring-card-outline";

/**
 * Shared approval-card shell (native backend gates + MCP fallback gates).
 *
 * Visual contract (theme tokens only, no literals): a soft fill
 * (`--card-soft`) plus a very low-contrast ring (`--card-outline`) in place of
 * a hard 1px border — borderless, but still unmistakably a card, which matters
 * because the approve/deny buttons need something to sit on. Dark mode falls
 * out of the CSS vars; no hardcoded colors.
 *
 * Sizing: the card is `w-full` inside the message column (max-w-3xl), so width
 * is inherited and stable, and height is content-driven. The `min-h-[140px]`
 * floor that used to hold the box steady when the gate swapped to a
 * spinner/result is GONE (2026-09-27): it reserved ~140px of dead space under
 * a one-line result, which the maintainer called out as a defect. The
 * remaining guard is the `max-h-[60vh]` cap with internal scroll, which keeps
 * a pathological preview from blowing the card up; the gate→result swap
 * therefore shifts the layout, and that shift is accepted. Preview bodies keep
 * their own tighter caps; the submit buttons always stay visible below the
 * scroll region.
 *
 * Bulk comes from `p-5` rather than a height floor: a gated call is a decision,
 * and the box should feel like it has room to make one. Padding grows with the
 * content instead of reserving space under it, so a one-line result still
 * collapses (what `min-h-[140px]` broke). `p-6` was rejected — past this the
 * args preview stops reading as the substance of the request and the card reads
 * as mostly margin.
 *
 * Buttons (see {@link ApprovalActions}): the approve/deny pair is `sm` on a
 * SOLID surface, never `outline`. The card fill is a few percent off the page
 * (`--card-soft`), so an outline button's 10% border and 15% fill land almost
 * on top of it — the button vanishes into the card and its label reads as dim
 * grey. `secondary` is a solid step away from the fill with full-strength
 * `text-secondary-foreground`, and `default` (ink) is reserved for the action a
 * reader should commit to. Existing shadcn variants only; no new colour.
 *
 * Motion (tw-animate-css only, no JS animation lib): 150ms enter
 * (fade + slight zoom, runs on mount) and a 100ms fade-out. The fade-out
 * needs the card to stay mounted for {@link APPROVAL_EXIT_MS} after the
 * click — call sites defer their submit via {@link useApprovalExit} for
 * exactly that long. Approval semantics are untouched; only the submit is
 * delayed by a UI tick.
 */
export const APPROVAL_EXIT_MS = 100;

export function ApprovalCard({
  title,
  description,
  trailing,
  leaving = false,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /**
   * Optional slot on the title row's trailing edge, for card-level metadata
   * that belongs beside the title rather than inside the body — the elapsed
   * time of the call being shown. Additive and optional: every existing caller
   * is unaffected, and the approval gate passes nothing so its row is unchanged.
   */
  trailing?: ReactNode;
  leaving?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "my-1 max-h-[60vh] w-full overflow-y-auto p-5 text-sm",
        CARD_SURFACE,
        leaving
          ? "animate-out fade-out-0 duration-100"
          : "animate-in fade-in-0 zoom-in-95 duration-150",
        // Marks the card holding the keyboard, and ONLY when several decisions
        // are on screen. Both facts are carried by the row's
        // `data-decision-owner` attribute, which `ApprovalActions` sets only
        // when it owns the keyboard AND the count is above one -- so a lone card
        // needs no pointer, since its arriving is the signal.
        //
        // An inset shadow rather than a border: a border would shove the content
        // 2px sideways the moment focus moved, and a jump like that is exactly
        // what an attention-drawing mark must not do.
        "has-[[data-decision-owner]]:shadow-[inset_2px_0_0_0_var(--primary)]",
        className,
      )}
    >
      {(title != null || trailing != null) && (
        <div className="mb-1 flex items-baseline justify-between gap-3">
          {title != null && (
            <div className="min-w-0 font-medium text-foreground">{title}</div>
          )}
          {trailing}
        </div>
      )}
      {description != null && (
        <p className="mb-1 text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

/**
 * Local leaving state for the 100ms exit fade. `runWithExit` sets the flag
 * (caller renders the shell with `leaving`) and invokes `fn` after
 * {@link APPROVAL_EXIT_MS}; `cancelExit` reverts (e.g. refused submit keeps
 * the gate retryable). Timer is cleared on unmount.
 */
export function useApprovalExit(ms: number = APPROVAL_EXIT_MS) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  const cancelExit = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setLeaving(false);
  };

  const runWithExit = (fn: () => void | Promise<void>) => {
    if (leaving) return;
    setLeaving(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      void fn();
    }, ms);
  };

  return { leaving, runWithExit, cancelExit };
}

function ApprovalSpinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3.5 animate-spin rounded-full border border-current border-t-transparent"
    />
  );
}

/**
 * Approve / Deny footer: primary Approve with Check icon, Deny with X icon on
 * the solid `secondary` surface (muted, never danger-red). Both are `sm`, so
 * the pair matches the declared-option buttons in `ApprovalGate` and one card
 * never mixes three button treatments. Stacks vertically on narrow viewports,
 * rows on sm+. While `busy`, Approve shows an in-place spinner and both
 * disable.
 *
 * ## Keyboard contract
 *
 * The row takes focus when the card appears, and from there:
 *
 *   - **Enter approves.** Native button activation once focus has been tabbed
 *     onto a button; handled explicitly while focus is on the row itself.
 *   - **Escape denies.** Handled here because no native control owns Escape.
 *   - Both are IME-guarded, and Tab still reaches the buttons in order.
 *
 * ## Where focus goes when there are several cards
 *
 * `OpenCodePermissions` renders a LIST of pending requests, so more than one card
 * on screen is an intended state rather than an edge case. The rules, both in
 * `lib/focus.ts`:
 *
 *   - **The topmost card owns the keyboard**, not the last one to mount. React
 *     runs sibling effects top-down, so taking focus on mount left focus on the
 *     bottom of the column: Enter drained the list from the far end and the
 *     reader scrolled to find what had changed. Draining from the top makes N
 *     cards N Enters, with the focused card always already on screen.
 *   - **A newly-arrived card never takes focus from the current owner.** Only
 *     the owner's departure frees the keyboard, and the next topmost card then
 *     claims it. Otherwise a second request arriving mid-answer would yank focus
 *     away.
 *
 * ## Deliberate limits
 *
 * 1. **No ring around the buttons, and no indicator at all for a lone card.** A
 *    ring drawn around a row of buttons reads as an error box -- "this is wrong"
 *    rather than "the keyboard is here". For one card the card's arrival is the
 *    signal. When several are stacked, a thin edge appears on the CARD holding
 *    the keyboard, which is the only moment a reader genuinely cannot tell which
 *    card they are on.
 * 2. **Focus is only taken when it is safe** (`canTakeFocusSafely`). A card
 *    appearing mid-sentence leaves the reader's caret where it is. It does NOT
 *    wait for a pause, time out, or steal focus on a timer.
 * 3. **Keys are local to the card.** There is no global "Enter approves" rule,
 *    because a document-level Enter handler would approve whatever request
 *    happened to be on screen while the reader typed into anything else. This
 *    is also OpenChamber's documented rule for shortcut scoping.
 *
 * Every call site inherits all of it -- this is the single choke point all four
 * permission surfaces go through, which is why it is here and not in them.
 */
export function ApprovalActions({
  busy = false,
  approveLabel = "Approve",
  denyLabel = "Deny",
  approveAria,
  denyAria,
  actionsAria,
  onApprove,
  onDeny,
}: {
  busy?: boolean;
  approveLabel?: string;
  denyLabel?: string;
  approveAria?: string;
  denyAria?: string;
  /**
   * Name announced when this row receives focus, because it is then the thing
   * Enter and Escape act on. Defaults to the approve label, which already names
   * the decision (`"Approve once: <title>"` on the native gate), so no call site
   * has to supply anything for the keyboard path to be usable.
   */
  actionsAria?: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  /**
   * The row itself is the keyboard target, NOT the Approve button.
   *
   * Focusing the button was the obvious choice and it is wrong here: the button
   * takes `disabled` while `busy`, and a disabled button drops focus to `<body>`.
   * That is the exact moment focus most needs to be somewhere deliberate — the
   * card is mid-decision. The row is never disabled, so focus survives.
   *
   * The cost is that Enter must be handled explicitly instead of arriving free
   * with button activation, which is why {@link ApprovalActions}'s `onKeyDown`
   * checks that the event landed on this element.
   */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /**
   * The row is REGISTERED rather than focusing itself. With several cards on
   * screen, "each one takes focus on mount" leaves focus on whichever React
   * mounted last -- the bottom of a column that renders top-down, so Enter
   * drains the list from the far end and the reader scrolls to find what
   * changed. `registerDecisionSurface` picks the topmost instead, and hands the
   * keyboard on when the owner leaves.
   */
  useEffect(() => {
    const element = surfaceRef.current;
    const release = registerDecisionSurface(element);
    return () => {
      // Asked of the REGISTRY, not of a ref captured when the effect ran: by
      // cleanup time any such value is stale, and this decides whether focus is
      // ours to give back. Released BEFORE restoring, so a card further down the
      // list can take the keyboard cleanly rather than racing the composer.
      const wasOwner = isDecisionSurfaceOwner(element);
      release();
      if (wasOwner) focusComposerInput();
    };
  }, []);

  const { count, isOwner } = useDecisionSurfaceFocus(surfaceRef.current);

  return (
    <div
      ref={surfaceRef}
      // Focusable but NOT in the tab order: `-1` means focus can arrive here
      // programmatically while Tab still walks into the buttons as before.
      tabIndex={-1}
      role="group"
      aria-label={actionsAria ?? approveAria ?? approveLabel}
      // Set ONLY when this row holds the keyboard AND more than one decision is
      // on screen. Both facts in one attribute, because `ApprovalCard` matches it
      // with a `:has()` rule: a lone card must stay unmarked, and without the
      // count folded in here the card shell would have no way to know.
      data-decision-owner={isOwner && count > 1 ? "" : undefined}
      onKeyDown={(e) => {
        // Escape declines, mirroring Enter approving. IME-guarded: closing a
        // candidate window is not consent to decline the request.
        if (isPlainEscape(e)) {
          e.preventDefault();
          onDeny();
          return;
        }
        // Enter approves — but ONLY when it lands on this row. Once focus moves
        // onto a button, that button activates natively, and handling Enter here
        // too would run `onApprove` twice for a single press.
        if (e.target !== e.currentTarget) return;
        if (isPlainEnter(e)) {
          e.preventDefault();
          onApprove();
        }
      }}
      // NO focus ring, by request. A ring drawn around a row of buttons reads
      // as an error state -- a box saying "this is wrong" -- rather than "the
      // keyboard is here", and it is the wrong signal on a decision surface.
      //
      // `outline-none` stays so the browser's own ring does not appear either.
      // What replaces it: nothing for a lone card (the card arriving IS the
      // signal, and there is nothing to disambiguate), and an accent on the CARD
      // itself when several are stacked -- see `ApprovalCard`.
      className="mt-4 flex flex-col gap-2 border-t border-border pt-3 focus:outline-none sm:flex-row"
    >
      <Button
        size="sm"
        disabled={busy}
        onClick={onApprove}
        aria-label={approveAria ?? approveLabel}
        className="active:scale-[0.98]"
      >
        {busy ? (
          <>
            <ApprovalSpinner /> Responding…
          </>
        ) : (
          <>
            <Check className="size-3.5" /> {approveLabel}
          </>
        )}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={onDeny}
        aria-label={denyAria ?? denyLabel}
        className="active:scale-[0.98]"
      >
        <X className="size-3.5" /> {denyLabel}
      </Button>
    </div>
  );
}

export type DecisionTone = "approved" | "denied" | "closed" | "auto";

/**
 * Outcome badge for decided states. Tones map to existing Badge variants;
 * denial uses the soft destructive chip, never a red button.
 */
export function DecisionBadge({
  tone,
  children,
}: {
  tone: DecisionTone;
  children: ReactNode;
}) {
  const variant =
    tone === "denied" ? "destructive" : tone === "approved" ? "secondary" : "outline";
  return <Badge variant={variant}>{children}</Badge>;
}

/**
 * Slim one-line row for decided states (approved / denied / cancelled /
 * closed / auto): status icon + truncated title + outcome badge + chevron.
 * Expand-on-click reveals the full content via the existing Radix
 * Collapsible. Terminal states render collapsed by default; pass
 * `defaultOpen` to start expanded (e.g. live executing spinner).
 */
export function CollapsedDecisionRow({
  icon,
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  icon?: ReactNode;
  title: string;
  badge: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn(
        "my-2 w-full px-3 py-2 text-sm animate-in fade-in-0 duration-150",
        CARD_SURFACE,
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${title} — ${open ? "collapse" : "expand"}`}
            className="flex w-full items-center gap-2 text-left"
          >
            {icon}
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {title}
            </span>
            {badge}
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
      </Collapsible>
    </div>
  );
}
