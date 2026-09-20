import { useEffect, useState, type ReactNode } from "react";
import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useAui } from "@assistant-ui/react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ApprovalActions,
  ApprovalCard,
  CollapsedDecisionRow,
  DecisionBadge,
  useApprovalExit,
} from "@/components/shared/approval-card";
import {
  approvalOptionApproves,
  approvalOptionLabel,
} from "@/components/shared/approval-options";
import { useStaleApprovalGuard } from "@/stores/stalePermissionsStore";
import { toolsConfig } from "@/config/tools";
import { logger } from "@/lib/logger";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

/**
 * Shared card primitives for native toolkit renderers.
 *
 * These renderers are UI-ONLY: execution happens server-side (streamText
 * `execute`), and privileged tools pause at a server approval gate answered
 * here via `respondToApproval()`. No fetches, no addResult, no client-side
 * execution — the deprecated human-tool cards (ToolUIs.tsx) are gone.
 */

export function ToolCard({
  title,
  leaving = false,
  children,
}: {
  title: string;
  leaving?: boolean;
  children: ReactNode;
}) {
  return (
    <ApprovalCard title={title} leaving={leaving}>
      {children}
    </ApprovalCard>
  );
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
      <span className="inline-block size-3 animate-spin rounded-full border border-current border-t-transparent" />
      {label}
    </span>
  );
}

type ApprovalState = NonNullable<AnyProps["approval"]>;
/** One declared choice on a gate — derived from the runtime's own type. */
type ApprovalOption = NonNullable<ApprovalState["options"]>[number];

/**
 * Approval card for server-gated tools. Renders only while the gate is open
 * (`approval.approved === undefined`); automatic decisions render as a badge.
 * If a future server ever attaches decision `options` or a `prompt`, they
 * render via the documented `optionId`/freeform response shapes (today's
 * server only emits plain boolean gates).
 *
 * Exported for the terminal adapter (run_command reuses the gate chrome
 * around the official Terminal Block instead of duplicating it).
 */
export function ApprovalGate({
  title,
  details,
  approval,
  respondToApproval,
  tool,
  targetPath,
}: {
  title: string;
  details: ReactNode;
  approval: ApprovalState;
  respondToApproval: AnyProps["respondToApproval"];
  /** Native tool name (e.g. "write_file") — enables the outside-workspace pre-check. */
  tool?: string;
  /** Requested path (or cwd for run_command) — resolved server-side for display. */
  targetPath?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeform, setFreeform] = useState("");
  // A declared option that opts into a confirmation step (e.g. "Always allow")
  // holds its id here until the user confirms; every other option resolves on
  // the first click. Nothing is sent while an option is merely held.
  const [confirmingOptionId, setConfirmingOptionId] = useState<string | null>(null);
  // 100ms exit fade: the submit below is deferred so the card can fade out
  // before the runtime swaps it for the result. Semantics unchanged — the
  // same response shape reaches respondToApproval, just a UI tick later.
  const { leaving, runWithExit, cancelExit } = useApprovalExit();
  const aui = useAui();
  // The SAME stale-permission guard the generic tool block uses. Shared rather
  // than re-implemented so this surface cannot drift from it — an approval path
  // without the guard is the original wedge (buttons that can only ever 404).
  const { stale, reportGone } = useStaleApprovalGuard(approval.id);

  // Outside-workspace pre-check (display only): ask the server whether the
  // requested path resolves outside this conversation's workspace. Failure
  // here never blocks the gate — worst case the warning is absent.
  const [outside, setOutside] = useState<{ resolvedTarget: string; root: string } | null>(null);
  useEffect(() => {
    if (!tool || !targetPath || approval.isAutomatic) return;
    let cancelled = false;
    (async () => {
      try {
        const item = aui.threadListItem.getState() as {
          remoteId?: string | null;
          id?: string | null;
        };
        const conversationId = item.remoteId ?? item.id;
        if (!conversationId) return;
        const res = await fetch("/api/tools/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, tool, path: targetPath }),
        });
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          inside?: boolean;
          resolvedTarget?: string;
          root?: string;
        } | null;
        if (!cancelled && data && data.inside === false && data.resolvedTarget) {
          setOutside({ resolvedTarget: data.resolvedTarget, root: data.root ?? "" });
        }
      } catch {
        /* display-only; gate works without it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tool, targetPath]);

  // A request the server has forgotten can never be answered from here either:
  // Approve and Deny both come back "Permission request not found", leaving a
  // card that cannot be dismissed. Render nothing — the same exit the generic
  // tool block takes. Presentation only; nothing is sent.
  if (stale) return null;

  if (approval.isAutomatic) {
    return (
      <CollapsedDecisionRow
        title={title}
        icon={<CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />}
        badge={<DecisionBadge tone="auto">Auto</DecisionBadge>}
      >
        {details}
        <div className="mt-2 text-muted-foreground">
          Auto-approved{approval.reason ? `: ${approval.reason}` : ""}
        </div>
      </CollapsedDecisionRow>
    );
  }

  const answer = (response: { approved: boolean; reason?: string; optionId?: string; text?: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // This card is the only place a user can refuse a gated tool, and nothing
    // recorded that a decision happened, which one, or whether the runtime
    // accepted it — so a wedged approval had no client-side evidence.
    logger.info("approval", "decision.submitted", {
      tool: tool ?? undefined,
      approved: response.approved,
      optionId: response.optionId ?? undefined,
      hasReason: response.reason !== undefined,
      automatic: approval.isAutomatic,
    });
    runWithExit(async () => {
      try {
        // Await acceptance so a refused response leaves the gate retryable.
        await respondToApproval(response);
        logger.debug("approval", "decision.accepted", {
          tool: tool ?? undefined,
          optionId: response.optionId ?? undefined,
        });
      } catch (e) {
        logger.warn("approval", "decision.failed", {
          tool: tool ?? undefined,
          optionId: response.optionId ?? undefined,
          errorType: e instanceof Error ? e.name : typeof e,
        });
        // Backstop: a reply that PROVES the request is gone retires the card,
        // rather than showing a retryable error for something that can never
        // succeed. An ordinary transient failure still stays retryable.
        if (reportGone(e)) return;
        cancelExit();
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    });
  };

  // The one path for a declared option. The decision is derived from the
  // option's kind: the runtime rejects a mismatch (choosing a `reject` option
  // while claiming approval throws), so a hardcoded `approved` would be wrong
  // for exactly the option that refuses.
  const chooseOption = (option: ApprovalOption) =>
    answer({ approved: approvalOptionApproves(option), optionId: option.id });

  // One-shot outside-workspace approval: mint the grant FIRST (server
  // re-resolves and canonicalizes the target itself), then answer the tool
  // gate. If minting fails the gate stays open — never approve blind.
  const approveOutside = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    runWithExit(async () => {
      try {
        const item = aui.threadListItem.getState() as {
          remoteId?: string | null;
          id?: string | null;
        };
        const conversationId = item.remoteId ?? item.id;
        if (!conversationId || !tool || !targetPath) {
          throw new Error("No conversation for this approval");
        }
        const res = await fetch("/api/tools/grant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, tool, path: targetPath }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) throw new Error(data?.error ?? "Could not authorize outside access");
        await respondToApproval({ approved: true });
      } catch (e) {
        // Same backstop as `answer`: a request the server no longer holds is
        // retired rather than left offering an action that cannot succeed.
        if (reportGone(e)) return;
        cancelExit();
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    });
  };

  const options = approval.options ?? [];
  const prompt = approval.prompt;
  const display = approval.display;
  const allowFreeform = approval.allowFreeform;
  // A gate that declares its choices renders ONLY those choices. The generic
  // approve/deny pair cannot express "always allow", and drawing both put two
  // decision surfaces on one card.
  const hasDeclaredOptions = options.length > 0;
  const confirmingOption =
    confirmingOptionId === null
      ? undefined
      : options.find((option) => option.id === confirmingOptionId);
  const confirmMeta =
    confirmingOption !== undefined && typeof confirmingOption.confirm === "object"
      ? confirmingOption.confirm
      : undefined;
  const confirmDescription =
    confirmMeta?.description ?? confirmingOption?.description;

  return (
    <ToolCard title={title} leaving={leaving}>
      {prompt ? <p className="mb-1 font-medium text-foreground">{prompt}</p> : details}
      {confirmingOption !== undefined ? (
        <div className="mt-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
          <p className="font-medium text-foreground">
            {confirmMeta?.title ?? `${approvalOptionLabel(confirmingOption)}?`}
          </p>
          {confirmDescription !== undefined && (
            <p className="mt-1 text-muted-foreground">{confirmDescription}</p>
          )}
          {confirmingOption.grants !== undefined &&
            confirmingOption.grants.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {confirmingOption.grants.map((grant) => (
                  <li key={grant}>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {grant}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void chooseOption(confirmingOption)}
            >
              Confirm
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmingOptionId(null)}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        hasDeclaredOptions && (
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option.id}
                size="xs"
                variant="outline"
                disabled={busy}
                aria-label={approvalOptionLabel(option)}
                title={option.description}
                onClick={() => {
                  if (option.confirm) {
                    setConfirmingOptionId(option.id);
                    return;
                  }
                  void chooseOption(option);
                }}
              >
                {approvalOptionLabel(option)}
              </Button>
            ))}
          </div>
        )
      )}
      {(display === "text" || allowFreeform) && (
        <div className="mt-2 flex gap-2">
          <input
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            placeholder="Type an answer…"
            aria-label="Approval answer"
            className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            size="xs"
            disabled={busy || !freeform.trim()}
            onClick={() => void answer({ approved: true, text: freeform.trim() })}
            aria-label="Submit answer"
          >
            Send
          </Button>
        </div>
      )}
      {outside && (
        <div
          className="mt-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
          role="note"
        >
          <div className="font-medium text-foreground">Outside the workspace</div>
          <div className="break-all text-muted-foreground">
            Resolves to {outside.resolvedTarget}
          </div>
          <div className="text-muted-foreground">
            Approving grants one-time access to this exact path. Future calls
            will ask again.
          </div>
        </div>
      )}
      {error && (
        <div className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
      {!hasDeclaredOptions && (
        <ApprovalActions
          busy={busy}
          approveAria={`Approve ${title}`}
          denyAria={`Deny ${title}`}
          onApprove={() => (outside ? approveOutside() : answer({ approved: true }))}
          onDeny={() => answer({ approved: false, reason: "Denied by user" })}
        />
      )}
    </ToolCard>
  );
}

/**
 * Denial classifier: returns the denial text only for an actual approval
 * denial. The AI SDK collapses both `output-denied` and `output-error` into
 * `{ error: string }`, so the error text alone cannot distinguish them — an
 * approved tool that later fails (e.g. workspace/symlink policy rejection)
 * must NOT render as "Denied". Ground truth is the approval marker:
 * denials carry `approved: false`; execution failures carry `approved: true`
 * or no marker. The string fallback covers genuine denies reloaded from
 * history where the marker was pruned (known SDK default strings only).
 */
export function denialOf(result: AnyResult, approval: AnyProps["approval"]): string | null {
  const r = result as { error?: unknown } | null | undefined;
  const err = r && typeof r === "object" && typeof r.error === "string" ? r.error : null;
  if (!err) return null;
  if (approval?.approved === false) return err;
  if (approval?.approved !== true && /deni|refus/i.test(err)) return err;
  return null;
}

function failureOf(result: AnyResult): string | null {
  const r = result as { error?: unknown } | null | undefined;
  if (r && typeof r === "object" && typeof r.error === "string") return r.error;
  return null;
}

/** Active thread's conversation id (same pattern as the Composer Stop handler). */
function useConversationId(): string | null {
  const aui = useAui();
  try {
    const item = aui.threadListItem.getState() as {
      remoteId?: string | null;
      id?: string | null;
    };
    return item.remoteId ?? item.id ?? null;
  } catch {
    return null;
  }
}

/** Outside-workspace refusal text (server messages, matched for retry UI only). */
const OUTSIDE_RE = /outside the workspace|escapes the workspace/i;

/** Ungated read tools eligible for one-shot granted retry from a Failed card. */
const READ_RETRY_TOOLS = new Set(["read_file", "list_dir", "search_files", "file_info"]);

/**
 * "Approve once" retry for an outside-workspace read failure: mints and
 * executes a one-shot grant server-side (single synchronous request — nothing
 * persists), then attaches the output to the SAME tool call via addResult so
 * the run continues. Deny merely dismisses the buttons (nothing executed, so
 * there is nothing to deny). Renders nothing unless every precondition holds.
 */
function FailedOutsideRetry({
  title,
  failed,
  tool,
  args,
}: {
  title: string;
  failed: string;
  tool?: string;
  args: AnyArgs;
}) {
  const conversationId = useConversationId();
  const aui = useAui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const addResult = (aui as unknown as { part?: { addToolResult?: (r: unknown) => void } })
    ?.part?.addToolResult;

  if (
    dismissed ||
    !addResult ||
    !tool ||
    !READ_RETRY_TOOLS.has(tool) ||
    !OUTSIDE_RE.test(failed)
  ) {
    return null;
  }

  const approveOnce = () => {
    if (busy || !conversationId) {
      if (!conversationId) setError("No conversation for this approval");
      return;
    }
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/tools/run-granted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, tool, args }),
        });
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          output?: unknown;
        } | null;
        if (!res.ok) throw new Error(data?.error ?? "Could not authorize outside access");
        addResult(data?.output ?? null);
        setDismissed(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    })();
  };

  return (
    <>
      {error && (
        <div className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
      <ApprovalActions
        busy={busy}
        approveLabel="Approve once"
        denyLabel="Deny"
        approveAria={`Approve once ${title} outside the workspace`}
        denyAria={`Deny ${title}`}
        onApprove={approveOnce}
        onDeny={() => setDismissed(true)}
      />
    </>
  );
}

/** Closed-gate notice (exported for the terminal adapter). */
export function ClosedGateMessage({ resolution }: { resolution: string }) {
  return (
    <span className="text-muted-foreground">
      {toolsConfig.copy.status.closedGate(resolution)}
    </span>
  );
}

/**
 * Status-driven dispatcher for backend tool parts (per the Tool UI docs'
 * state model). `status` is the primary signal; approval/result secondary:
 * requires-action (open gate) → approval card; closed gate without decision →
 * closed message (never a spinner); running → progress; incomplete → error
 * message with reason; complete/result → summary.
 */
export function BackendToolView({
  title,
  args,
  argPreview,
  result,
  status,
  approval,
  respondToApproval,
  runningLabel,
  summarize,
  tool,
  targetPath,
  variant = "card",
}: {
  title: string;
  args: AnyArgs;
  argPreview?: ReactNode;
  result: AnyResult;
  status: AnyProps["status"];
  approval: AnyProps["approval"];
  respondToApproval: AnyProps["respondToApproval"];
  runningLabel: string;
  summarize: (result: AnyResult, args?: AnyArgs) => ReactNode;
  /** Native tool name — enables the outside-workspace pre-check on the gate. */
  tool?: string;
  /** Requested path (or cwd) — resolved server-side for the pre-check display. */
  targetPath?: string;
  /** Presentation variant: standard full card or lightweight compact row. */
  variant?: "card" | "compact";
}) {
  if (approval && approval.approved === undefined) {
    if (approval.resolution) {
      return (
        <CollapsedDecisionRow
          title={title}
          icon={<XCircle className="size-3.5 shrink-0 text-muted-foreground" />}
          badge={<DecisionBadge tone="closed">Closed</DecisionBadge>}
        >
          <ClosedGateMessage resolution={approval.resolution} />
        </CollapsedDecisionRow>
      );
    }
    return (
      <ApprovalGate
        title={title}
        details={argPreview ?? <Json value={args} />}
        approval={approval}
        respondToApproval={respondToApproval}
        tool={tool}
        targetPath={targetPath}
      />
    );
  }
  // Approved but the result has not arrived: never render "Failed" for this —
  // execution is pending on the continuation, or the decision expired (in
  // which case the next message simply requires a fresh approval).
  if (approval?.approved === true && result === undefined && status?.type !== "running") {
    return (
      <CollapsedDecisionRow
        title={title}
        icon={<CheckCircle2 className="size-3.5 shrink-0 text-success" />}
        badge={<DecisionBadge tone="approved">Approved</DecisionBadge>}
      >
        <span className="text-muted-foreground">
          {toolsConfig.copy.status.approvedWillExecute}
        </span>
      </CollapsedDecisionRow>
    );
  }
  if (status?.type === "incomplete") {
    const reason =
      (status as { reason?: unknown }).reason ?? approval?.reason ?? "unknown";
    const cancelled = String(reason) === "cancelled" || reason === "cancelled";
    return (
      <CollapsedDecisionRow
        title={title}
        icon={
          <XCircle
            className={
              cancelled
                ? "size-3.5 shrink-0 text-muted-foreground"
                : "size-3.5 shrink-0 text-destructive"
            }
          />
        }
        badge={
          <DecisionBadge tone={cancelled ? "closed" : "denied"}>
            {cancelled ? "Cancelled" : "Failed"}
          </DecisionBadge>
        }
      >
        <span className="text-destructive" role="alert">
          {cancelled
            ? toolsConfig.copy.status.cancelledBeforeCompletion
            : toolsConfig.copy.status.failedWithReason(String(reason))}
        </span>
      </CollapsedDecisionRow>
    );
  }
  if (result !== undefined) {
    const denied = denialOf(result, approval);
    if (denied) {
      return (
        <CollapsedDecisionRow
          title={title}
          icon={<XCircle className="size-3.5 shrink-0 text-destructive" />}
          badge={<DecisionBadge tone="denied">Denied</DecisionBadge>}
        >
          <span className="text-destructive" role="alert">
            {toolsConfig.copy.status.deniedWithReason(denied)}
          </span>
        </CollapsedDecisionRow>
      );
    }
    const failed = failureOf(result);
    if (failed) {
      return (
        <CollapsedDecisionRow
          title={title}
          icon={<XCircle className="size-3.5 shrink-0 text-destructive" />}
          badge={<DecisionBadge tone="denied">Failed</DecisionBadge>}
        >
          <span className="text-destructive" role="alert">
            {toolsConfig.copy.status.failedWithReason(failed)}
          </span>
          <FailedOutsideRetry title={title} failed={failed} tool={tool} args={args} />
        </CollapsedDecisionRow>
      );
    }
    if (variant === "compact") {
      return (
        <div className="my-1 flex w-full items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          {summarize(result, args)}
        </div>
      );
    }
    return <ToolCard title={title}>{summarize(result, args)}</ToolCard>;
  }
  // Waiting on the reader with NO gate of its own. OpenCode's `question` tool is
  // this case: the prompt IS the request, and it is answered on the dedicated
  // question surface, so there is nothing for this card to approve. Showing the
  // request beats a spinner, which would read as "still working" for something
  // that is actually blocked on a person. `argPreview` is the existing hook for
  // "what this call is about", so no new prop or card machinery is added.
  if (status?.type === "requires-action" && !approval) {
    return (
      <ToolCard title={title}>{argPreview ?? <Json value={args} />}</ToolCard>
    );
  }
  return (
    <ToolCard title={title}>
      {approval?.approved === true ? (
        <Spinner label={toolsConfig.copy.running.approvedExecuting} />
      ) : (
        <Spinner label={runningLabel} />
      )}
    </ToolCard>
  );
}

export function dirSummary(result: AnyResult) {
  const r = result as any;
  const entries = (r?.entries ?? []) as { name: string; type: string; size: number | null }[];
  if (entries.length === 0) return <span className="text-muted-foreground">{toolsConfig.copy.status.emptyFolder}</span>;
  return (
    <div className="space-y-0.5">
      {entries.slice(0, 100).map((e) => (
        <div key={e.name} className="flex justify-between gap-2">
          <span className="truncate">
            {e.type === "dir" ? "📁" : "📄"} {e.name}
          </span>
          {e.size != null && <span className="shrink-0 text-muted-foreground">{e.size} B</span>}
        </div>
      ))}
      {entries.length > 100 && (
        <div className="text-muted-foreground">{toolsConfig.copy.status.andMoreCount(entries.length - 100)}</div>
      )}
    </div>
  );
}

export function searchSummary(result: AnyResult) {
  const r = result as any;
  const matches = (r?.matches ?? []) as { path: string; line: number; snippet: string }[];
  if (matches.length === 0)
    return <span className="text-muted-foreground">{toolsConfig.copy.status.noMatchesInFiles(r?.filesScanned ?? 0)}</span>;
  return (
    <div className="space-y-1">
      {matches.map((m, i) => (
        <div key={i} className="truncate">
          <span className="font-medium text-foreground">{m.path}:{m.line}</span>{" "}
          <span className="text-muted-foreground">{m.snippet}</span>
        </div>
      ))}
      {r?.truncated && <div className="text-muted-foreground">{toolsConfig.copy.status.moreMatchesOmitted}</div>}
    </div>
  );
}

/** Cap a long body so a big file result cannot blow up the transcript. */
export function textPreview(text: string, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} more chars)` : text;
}

export const ReadFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`read_file · ${String(p.args.path ?? "")}`}
    tool="read_file"
    targetPath={String(p.args.path ?? "")}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.reading}
    summarize={(r) => <Json value={(r as any).content} />}
  />
);

export const ListDirToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`list_dir · ${String(p.args.path ?? ".")}`}
    tool="list_dir"
    targetPath={String(p.args.path ?? ".")}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.listing}
    summarize={dirSummary}
  />
);

export const SearchFilesToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`search_files · ${String(p.args.query ?? "")}`}
    tool="search_files"
    targetPath={String((p.args as { path?: unknown }).path ?? ".")}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.searching}
    summarize={searchSummary}
  />
);

export const FileInfoToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`file_info · ${String(p.args.path ?? "")}`}
    tool="file_info"
    targetPath={String(p.args.path ?? "")}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.reading}
    summarize={(r) => <Json value={r} />}
  />
);

export const WriteFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`write_file · ${String(p.args.path ?? "")}`}
    tool="write_file"
    targetPath={String(p.args.path ?? "")}
    args={p.args}
    argPreview={
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {typeof p.args.content === "string" ? textPreview(p.args.content) : ""}
      </pre>
    }
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.writing}
    summarize={(r) => <Json value={r} />}
  />
);

export const EditFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`edit_file · ${String(p.args.path ?? "")}`}
    tool="edit_file"
    targetPath={String(p.args.path ?? "")}
    args={p.args}
    argPreview={
      <div className="space-y-1 text-xs">
        <div className="text-muted-foreground">Find:</div>
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
          {typeof p.args.oldText === "string" ? textPreview(p.args.oldText, 500) : ""}
        </pre>
        <div className="text-muted-foreground">Replace with:</div>
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
          {typeof p.args.newText === "string" ? textPreview(p.args.newText, 500) : ""}
        </pre>
      </div>
    }
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.editing}
    summarize={(r) => <Json value={r} />}
  />
);

export const DeleteFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`delete_file · ${String(p.args.path ?? "")}`}
    tool="delete_file"
    targetPath={String(p.args.path ?? "")}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.deleting}
    summarize={(r) => <Json value={r} />}
  />
);
