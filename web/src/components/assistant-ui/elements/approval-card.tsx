"use client";

/**
 * Official assistant-ui "Approval card" element, vendored from the registry:
 *
 *   https://r.assistant-ui.com/elements-approval-card.json
 *   path: components/assistant-ui/elements/approval-card.tsx
 *
 * Copied by hand rather than via `shadcn add` because this repo has no
 * `components.json`. It brings **no** npm dependency; its only registry
 * dependency (`./surfaces`, for `paper`/`field`/`inkButton`) is already vendored.
 *
 * ONE adaptation from upstream, and nothing else: the four lucide icons are
 * aliased, because `lucide-react@0.469.0` (the installed version) exports only
 * the un-suffixed names — there is no `TerminalIcon`, `CheckIcon`, `Loader2Icon`
 * or `XIcon`. The vendored `terminal-block.tsx` documents the same adaptation.
 *
 * NOTE ON THE BUTTONS — this is the mechanism TBAi's adapter relies on: each
 * button renders **only when its callback is supplied**. So "hide the option the
 * host did not offer" is expressed by *not passing* that callback, with no fork
 * and no prop added. See `features/permissions/approvalOptionMapping.ts`.
 */

import {
  Check as CheckIcon,
  Loader as Loader2Icon,
  Terminal as TerminalIcon,
  X as XIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { field, inkButton, paper } from "./surfaces";

export type ApprovalState = "request" | "running" | "done" | "denied";

export function ApprovalCard({
  state,
  command,
  title,
  subtitle,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "state"
  | "command"
  | "title"
  | "subtitle"
  | "onAllowOnce"
  | "onAlwaysAllow"
  | "onDeny"
> & {
  state: ApprovalState;
  command: string;
  title: string;
  subtitle: string;
  onAllowOnce?: () => void;
  onAlwaysAllow?: () => void;
  onDeny?: () => void;
}) {
  return (
    <div
      data-slot="approval-card"
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col gap-3.5 rounded-[20px] p-4",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-3">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-9 shrink-0 items-center justify-center rounded-xl">
          <TerminalIcon className="size-4" />
        </span>
        <div className="flex flex-col">
          <p className="text-[13.5px] font-medium">{title}</p>
          <p className="text-foreground/45 text-xs">{subtitle}</p>
        </div>
      </div>

      <div
        className={cn(
          field,
          "text-foreground/70 rounded-xl px-3.5 py-2.5 font-mono text-xs",
        )}
      >
        {command}
      </div>

      <div className="flex h-8 items-center justify-end gap-2">
        {state === "request" ? (
          <>
            {onDeny && (
              <button
                type="button"
                onClick={onDeny}
                className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
              >
                Deny
              </button>
            )}
            {onAlwaysAllow && (
              <button
                type="button"
                onClick={onAlwaysAllow}
                className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
              >
                Always allow
              </button>
            )}
            {onAllowOnce && (
              <button
                type="button"
                onClick={onAllowOnce}
                className={cn(
                  inkButton,
                  "flex h-8 items-center rounded-full px-3.5 text-xs font-medium",
                )}
              >
                Allow once
              </button>
            )}
          </>
        ) : (
          <div
            key={state}
            className="fade-in animate-in text-foreground/55 flex items-center gap-2 text-xs duration-300"
          >
            {state === "running" ? (
              <>
                <Loader2Icon className="text-foreground/45 size-3.5 animate-spin" />
                Approved, running
              </>
            ) : state === "denied" ? (
              <>
                <XIcon className="text-foreground/45 size-3.5" />
                Denied
              </>
            ) : (
              <>
                <CheckIcon className="size-3.5 text-emerald-500" />
                Finished with exit 0
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
