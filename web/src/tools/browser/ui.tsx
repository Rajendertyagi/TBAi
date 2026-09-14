import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView } from "../filesystem/ui";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

type BrowserResult = {
  action: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  path?: string;
  mimeType?: string;
};

/**
 * Render-only browser tool views. Execution happens server-side (the
 * agent-browser CLI); these cards only display the structured result. For
 * screenshots the structured `path`/`mimeType` are surfaced as text — actual
 * image rendering is deferred until TBAi exposes a workspace/static-file
 * mechanism that can safely serve the file.
 */
function browserTitle(args: AnyArgs): string {
  const action = String(args.action ?? "");
  const detail = [args.url, args.ref, args.key, args.prompt, args.text]
    .filter(Boolean)
    .map(String)[0];
  return `browser · ${action}${detail ? ` ${detail}` : ""}`;
}

function browserSummary(result: AnyResult) {
  const r = result as BrowserResult | undefined;
  if (!r) return null;

  if (r.path) {
    return (
      <div className="space-y-1">
        <div className="text-muted-foreground">
          {r.ok ? "Screenshot saved" : "Screenshot failed"}: {r.path}
        </div>
        {r.stdout ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {r.stdout.slice(0, 4000)}
          </pre>
        ) : null}
      </div>
    );
  }

  const output = [r.stdout, r.stderr].filter(Boolean).join("\n").slice(0, 4000);
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
      {output || (r.ok ? "ok" : `exit ${r.exitCode ?? "?"}`)}
    </pre>
  );
}

export const BrowserToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={browserTitle(p.args)}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Browsing…"
    summarize={browserSummary}
  />
);

export const BrowserActionToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={browserTitle(p.args)}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Acting…"
    summarize={browserSummary}
  />
);
