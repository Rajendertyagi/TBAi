"use client";

import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { messageActionsConfig } from "@/config/messageActions";
import { TooltipIconButton } from "./tooltip-icon-button";

/** Copy the message, swapping icon and tooltip in place after a copy. */
export function MessageCopyAction() {
  // One read, not the documented `AuiIf` pair around each icon: the SAME
  // boolean also selects the tooltip text, and two subscriptions to one value
  // would be a second source of truth for the same fact.
  const isCopied = useAuiState((s) => s.message.isCopied);
  return (
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton
        tooltip={
          isCopied ? messageActionsConfig.copy.copiedTooltip : messageActionsConfig.copy.tooltip
        }
        side="bottom"
      >
        {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  );
}

/** Re-run the turn that produced this message, from this message. */
function MessageRegenerateAction() {
  return (
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton tooltip={messageActionsConfig.regenerate.tooltip} side="bottom">
        <RefreshCw className="size-3.5" />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  );
}

/**
 * The action row under an assistant answer: copy and regenerate, grouped in
 * the element's root so both act on the message scope they render inside.
 *
 * ## Provenance
 *
 * Vendored from assistant-ui's `message-actions` element
 * (`npx assistant-ui add message-actions`). The composition — one
 * `ActionBarPrimitive.Root` whose children are the action primitives — is the
 * upstream one. Three adaptations are deliberate:
 *
 * 1. **Buttons are `TooltipIconButton`.** Upstream's row uses bare `<button>`
 *    with `ghostButton`. This app has exactly one icon button, and it carries
 *    the tooltip plus the screen-reader label the DOM tests locate; a second
 *    icon-button spelling would be a competing primitive.
 * 2. **`autohide` keeps upstream's default (`"never"`).** The demo passes
 *    `"not-last"`, which returns `null` for every message but the last and
 *    reveals the row only on hover. The provenance row shares this line, so a
 *    hover-only bar would shove the time and model chips sideways every time
 *    the pointer crossed a past message.
 * 3. **No feedback buttons and no more-menu.** Feedback has no persistence or
 *    metadata contract in this app, and the menu would have no items to offer.
 *
 * All reader-facing copy comes from `messageActionsConfig`.
 */
export function MessageActions({ className }: { className?: string }) {
  return (
    <ActionBarPrimitive.Root
      data-slot="message-actions"
      className={cn("flex items-center gap-0.5", className)}
    >
      <MessageCopyAction />
      <MessageRegenerateAction />
    </ActionBarPrimitive.Root>
  );
}
