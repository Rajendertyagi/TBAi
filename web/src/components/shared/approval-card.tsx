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
  leaving = false,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
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
        className,
      )}
    >
      {title != null && (
        <div className="mb-1 font-medium text-foreground">{title}</div>
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
 */
export function ApprovalActions({
  busy = false,
  approveLabel = "Approve",
  denyLabel = "Deny",
  approveAria,
  denyAria,
  onApprove,
  onDeny,
}: {
  busy?: boolean;
  approveLabel?: string;
  denyLabel?: string;
  approveAria?: string;
  denyAria?: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row">
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
