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
 * Shared approval-card shell (native backend gates + MCP fallback gates).
 *
 * Visual contract (our tokens only, no new ones): flat card, 1px border,
 * inner-panel radius — the same `rounded-2xl / border-border / bg-card`
 * step the composer and Select content already use. Dark mode falls out of
 * the CSS vars; no hardcoded colors.
 *
 * Sizing: the card is `w-full` inside the message column (max-w-3xl), so
 * width is inherited and stable. Height is content-driven with a floor and
 * a viewport guard: `min-h-[140px]` stops layout jumps when the gate swaps
 * to spinner/result, `max-h-[60vh]` (with internal scroll) keeps pathological
 * previews from blowing the card up. Preview bodies keep their own tighter
 * caps; the submit buttons always stay visible below the scroll region.
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
        "my-1 max-h-[60vh] w-full min-h-[140px] overflow-y-auto rounded-2xl border border-border bg-card p-4 text-sm",
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
 * Approve / Deny footer: primary Approve with Check icon, outline Deny with
 * X icon (muted, never danger-red). Stacks vertically on narrow viewports,
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
        variant="outline"
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
    <div className="my-2 w-full rounded-2xl border border-border bg-card px-3 py-2 text-sm animate-in fade-in-0 duration-150">
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
