"use client";

import { useState } from "react";
import {
  useOpenCodePermissions,
  type OpenCodePermissionRequest,
  type OpenCodePermissionResponse,
} from "@assistant-ui/react-opencode";
import {
  ApprovalCard,
  ApprovalActions,
  useApprovalExit,
} from "@/components/shared/approval-card";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";
import {
  isPermissionGone,
  useStalePermissionsStore,
} from "@/stores/stalePermissionsStore";
import { useStalePermissionReconcile } from "./stalePermissions";
import { unlinkedPendingPermissions } from "./panelInteractions";

/** Human-readable summary of what the permission covers. */
function describeRequest(req: OpenCodePermissionRequest): string {
  const parts: string[] = [];
  if (req.patterns.length > 0) parts.push(req.patterns.join(", "));
  if (req.toolInput != null) {
    try {
      parts.push(
        typeof req.toolInput === "string"
          ? req.toolInput
          : JSON.stringify(req.toolInput),
      );
    } catch {
      /* ignore non-serializable input */
    }
  }
  return parts.join("  ·  ");
}

/**
 * Single pending OpenCode permission rendered in the shared ApprovalCard shell.
 * Approve = one-shot (`once`); Deny = `reject`. An "Always allow" action is
 * shown only when OpenCode advertises persist patterns for this request
 * (`request.always`), and it delegates the decision to OpenCode (`always`) —
 * we never persist anything host-side.
 */
function PermissionCard({
  request,
  reply,
}: {
  request: OpenCodePermissionRequest;
  reply: (id: string, response: OpenCodePermissionResponse) => Promise<void>;
}) {
  const { leaving, runWithExit, cancelExit } = useApprovalExit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markStale = useStalePermissionsStore((s) => s.markStale);

  const offersAlways = request.always.length > 0;
  const title = request.title ?? request.toolName ?? request.permission;
  const description = describeRequest(request);

  const submit = (response: OpenCodePermissionResponse) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    runWithExit(async () => {
      try {
        await reply(request.id, response);
      } catch (e) {
        // "Permission request not found" means the server no longer holds this
        // permission (it keeps them in memory only), so neither Approve nor
        // Deny can ever succeed. Retire the card via the official exit
        // condition instead of leaving buttons that can only 404.
        if (isPermissionGone(e)) markStale([request.id]);
        cancelExit();
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    });
  };

  return (
    <ApprovalCard title={title} leaving={leaving}>
      {description && (
        <p className="mb-1 text-muted-foreground">{description}</p>
      )}
      {error && (
        <div className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
      <ApprovalActions
        busy={busy}
        approveLabel="Approve once"
        denyLabel="Deny"
        approveAria={`Approve once: ${title}`}
        denyAria={`Deny: ${title}`}
        onApprove={() => submit("once")}
        onDeny={() => submit("reject")}
      />
      {offersAlways && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => submit("always")}
            aria-label={`Always allow: ${title}`}
          >
            <ShieldCheck className="size-3.5" /> Always (remembered by OpenCode, all chats)
          </Button>
        </div>
      )}
    </ApprovalCard>
  );
}

/**
 * OpenCode permission surface for Code mode — a FALLBACK, not a history.
 *
 * A request linked to a tool call renders its approval on that tool's card
 * inside the message (the same place direct chat renders approvals), so it is
 * never listed here. This surface exists only for a request with no tool card,
 * which would otherwise be unanswerable and leave the tool running forever; it
 * disappears the moment that request is answered. Mounted as a sibling of
 * ChatWindow (never inside it) so the ChatWindow stays
 * assistant-ui-primitives-only.
 */
export function OpenCodePermissions() {
  const { pending, reply } = useOpenCodePermissions();
  const stale = useStalePermissionsStore((s) => s.stale);
  // Retire cards the server no longer holds (directory-scoped; see the hook).
  useStalePermissionReconcile();

  // Tool-linked requests are projected into assistant-ui's standard tool
  // approval contract and rendered inside the message; a request the server has
  // forgotten can never be answered. Neither belongs on this surface.
  const unlinked = unlinkedPendingPermissions(pending, stale);

  if (unlinked.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {unlinked.map((req) => (
        <PermissionCard key={req.id} request={req} reply={reply} />
      ))}
    </div>
  );
}
