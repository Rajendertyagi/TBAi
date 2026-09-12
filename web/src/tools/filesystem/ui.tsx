import { useState, type ReactNode } from "react";
import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Button } from "@/components/ui/button";

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

export function ToolCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="my-1 w-full rounded-md border border-border bg-background/60 p-3 text-xs">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      {children}
    </div>
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
type ApprovalOption = {
  id: string;
  kind?: string;
  label?: string;
};

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
}: {
  title: string;
  details: ReactNode;
  approval: ApprovalState;
  respondToApproval: AnyProps["respondToApproval"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freeform, setFreeform] = useState("");

  if (approval.isAutomatic) {
    return (
      <ToolCard title={title}>
        {details}
        <div className="mt-2 text-muted-foreground">
          Auto-approved{approval.reason ? `: ${approval.reason}` : ""}
        </div>
      </ToolCard>
    );
  }

  const answer = async (response: { approved: boolean; reason?: string; optionId?: string; text?: string }) => {    setBusy(true);
    setError(null);
    try {
      // Await acceptance so a refused response leaves the gate retryable.
      await respondToApproval(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const options = (approval.options ?? []) as ApprovalOption[];
  const prompt = (approval as { prompt?: string }).prompt;
  const display = (approval as { display?: string }).display;
  const allowFreeform = (approval as { allowFreeform?: boolean }).allowFreeform;

  return (
    <ToolCard title={title}>
      {prompt ? <p className="mb-1 font-medium text-foreground">{prompt}</p> : details}
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((o) => (
            <Button
              key={o.id}
              size="xs"
              variant="outline"
              disabled={busy}
              aria-label={o.label ?? o.id}
              onClick={() => void answer({ approved: true, optionId: o.id })}
            >
              {o.label ?? o.id}
            </Button>
          ))}
        </div>
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
      {error && (
        <div className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button
          size="xs"
          disabled={busy}
          onClick={() => void answer({ approved: true })}
          aria-label={`Approve ${title}`}
        >
          {busy ? "Responding…" : "Approve"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void answer({ approved: false, reason: "Denied by user" })}
          aria-label={`Deny ${title}`}
        >
          Deny
        </Button>
      </div>
    </ToolCard>
  );
}

function isDenied(result: AnyResult): string | null {
  const r = result as { error?: unknown } | null | undefined;
  if (r && typeof r === "object" && typeof r.error === "string") return r.error;
  return null;
}

/** Closed-gate notice (exported for the terminal adapter). */
export function ClosedGateMessage({ resolution }: { resolution: string }) {
  return (
    <span className="text-muted-foreground">
      Approval {resolution} before a decision — run the request again if still needed.
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
}: {
  title: string;
  args: AnyArgs;
  argPreview?: ReactNode;
  result: AnyResult;
  status: AnyProps["status"];
  approval: AnyProps["approval"];
  respondToApproval: AnyProps["respondToApproval"];
  runningLabel: string;
  summarize: (result: AnyResult) => ReactNode;
}) {
  if (approval && approval.approved === undefined) {
    if (approval.resolution) {
      return (
        <ToolCard title={title}>
          <ClosedGateMessage resolution={approval.resolution} />
        </ToolCard>
      );
    }
    return (
      <ApprovalGate
        title={title}
        details={argPreview ?? <Json value={args} />}
        approval={approval}
        respondToApproval={respondToApproval}
      />
    );
  }
  // Approved but the result has not arrived: never render "Failed" for this —
  // execution is pending on the continuation, or the decision expired (in
  // which case the next message simply requires a fresh approval).
  if (approval?.approved === true && result === undefined && status?.type !== "running") {
    return (
      <ToolCard title={title}>
        <span className="text-muted-foreground">
          Approved — will execute with your next message in this conversation.
        </span>
      </ToolCard>
    );
  }
  if (status?.type === "incomplete") {
    const reason =
      (status as { reason?: unknown }).reason ?? approval?.reason ?? "unknown";
    return (
      <ToolCard title={title}>
        <span className="text-destructive" role="alert">
          {String(reason) === "cancelled" || reason === "cancelled"
            ? "Cancelled before completion."
            : `Failed: ${String(reason)}`}
        </span>
      </ToolCard>
    );
  }
  if (result !== undefined) {
    const denied = isDenied(result);
    if (denied) {
      return (
        <ToolCard title={title}>
          <span className="text-destructive" role="alert">
            Denied: {denied}
          </span>
        </ToolCard>
      );
    }
    return <ToolCard title={title}>{summarize(result)}</ToolCard>;
  }
  return (
    <ToolCard title={title}>
      {approval?.approved === true ? (
        <Spinner label="Approved — executing…" />
      ) : (
        <Spinner label={runningLabel} />
      )}
    </ToolCard>
  );
}

export function dirSummary(result: AnyResult) {
  const r = result as any;
  const entries = (r?.entries ?? []) as { name: string; type: string; size: number | null }[];
  if (entries.length === 0) return <span className="text-muted-foreground">Empty folder.</span>;
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
        <div className="text-muted-foreground">…and {entries.length - 100} more</div>
      )}
    </div>
  );
}

export function searchSummary(result: AnyResult) {
  const r = result as any;
  const matches = (r?.matches ?? []) as { path: string; line: number; snippet: string }[];
  if (matches.length === 0)
    return <span className="text-muted-foreground">No matches in {r?.filesScanned ?? 0} files.</span>;
  return (
    <div className="space-y-1">
      {matches.map((m, i) => (
        <div key={i} className="truncate">
          <span className="font-medium text-foreground">{m.path}:{m.line}</span>{" "}
          <span className="text-muted-foreground">{m.snippet}</span>
        </div>
      ))}
      {r?.truncated && <div className="text-muted-foreground">…more matches omitted</div>}
    </div>
  );
}

function textPreview(text: string, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} more chars)` : text;
}

export const ReadFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`read_file · ${String(p.args.path ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Reading…"
    summarize={(r) => <Json value={(r as any).content} />}
  />
);

export const ListDirToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`list_dir · ${String(p.args.path ?? ".")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Listing…"
    summarize={dirSummary}
  />
);

export const SearchFilesToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`search_files · ${String(p.args.query ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Searching…"
    summarize={searchSummary}
  />
);

export const FileInfoToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`file_info · ${String(p.args.path ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Reading…"
    summarize={(r) => <Json value={r} />}
  />
);

export const WriteFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`write_file · ${String(p.args.path ?? "")}`}
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
    runningLabel="Writing…"
    summarize={(r) => <Json value={r} />}
  />
);

export const EditFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`edit_file · ${String(p.args.path ?? "")}`}
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
    runningLabel="Editing…"
    summarize={(r) => <Json value={r} />}
  />
);

export const DeleteFileToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`delete_file · ${String(p.args.path ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Deleting…"
    summarize={(r) => <Json value={r} />}
  />
);
