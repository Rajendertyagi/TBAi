"use client";

import { useState } from "react";
import { ApprovalCard, ApprovalActions, useApprovalExit } from "@/components/shared/approval-card";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";
import {
  isStaleApproval,
  useStaleApprovalGuard,
  useStalePermissionsStore,
} from "@/stores/stalePermissionsStore";
import { useOptionalV2RuntimeExtras } from "./v2RuntimeExtras";
import type { V2PermissionView } from "./v2Permissions";

function PermissionCard({ request }: { request: V2PermissionView }) {
  const extras = useOptionalV2RuntimeExtras();
  const { leaving, runWithExit, cancelExit } = useApprovalExit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The SAME guard the tool-card surfaces use — a permission the server has
  // forgotten can only ever answer "not found", so offering controls here is the
  // same dead end the guard exists to prevent.
  const { stale, reportGone } = useStaleApprovalGuard(request.id);
  if (!extras) return null;
  // Retire rather than offer two buttons that can only fail.
  if (stale) return null;
  const title = request.message ?? request.action;
  const description = request.resources.join("  ·  ");
  const submit = (decision: "once" | "always" | "reject") => {
    if (busy) return;
    setBusy(true); setError(null);
    runWithExit(async () => {
      try { await extras.replyToPermission(request.id, decision); }
      catch (cause) {
        // Gone for good: the store update unmounts this card, so there is
        // nothing left to show an error on. Anything else stays retryable.
        if (reportGone(cause)) return;
        cancelExit();
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      }
    });
  };
  return <ApprovalCard title={title} leaving={leaving}>
    {description && <p className="mb-1 break-all text-muted-foreground">{description}</p>}
    {error && <div className="mt-1 text-xs text-destructive" role="alert">{error}</div>}
    <ApprovalActions busy={busy} approveLabel="Approve once" denyLabel="Deny" approveAria={`Approve once: ${title}`} denyAria={`Deny: ${title}`} onApprove={() => submit("once")} onDeny={() => submit("reject")} />
    {request.savePatterns.length > 0 && <div className="mt-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => submit("always")} aria-label={`Always allow: ${title}`}><ShieldCheck className="size-3.5" /> Always (remembered by OpenCode, all chats)</Button></div>}
  </ApprovalCard>;
}

/** Native permission fallback panel; linked permissions render on their tool cards. */
export function OpenCodePermissions() {
  const extras = useOptionalV2RuntimeExtras();
  // Subscribed here (not per card) because this surface is a LIST: a stale
  // request must stop being listed, not merely render empty.
  const staleIds = useStalePermissionsStore((state) => state.stale);
  if (!extras) return null;
  const unlinked = extras.permissions.filter(
    (permission) => permission.toolCallId === null && !isStaleApproval(permission.id, staleIds),
  );
  if (unlinked.length === 0) return null;
  return <div className="flex flex-col gap-2 px-3 py-2">{unlinked.map((request) => <PermissionCard key={request.id} request={request} />)}</div>;
}
