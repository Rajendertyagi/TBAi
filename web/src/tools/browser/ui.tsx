import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView } from "../filesystem/ui";
import { BoundedBody } from "@/tools/body-budget";
import { toolsConfig } from "@/config/tools";

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
          {r.ok ? toolsConfig.copy.status.screenshotSaved : toolsConfig.copy.status.screenshotFailed}: {r.path}
        </div>
        {r.stdout ? <BoundedBody text={r.stdout} /> : null}
      </div>
    );
  }

  // Bounded, and it says so when it cuts. This used to be a hardcoded
  // `slice(0, 4000)` with no notice at all, so a reader of a long page scrape
  // or a verbose CLI saw a block that stopped mid-sentence and had no way to
  // know it was one fortieth of what the tool returned - a silent truncation
  // reads as a complete answer.
  const output = [r.stdout, r.stderr].filter(Boolean).join("\n");
  return (
    <BoundedBody
      text={output}
      empty={r.ok ? "ok" : `exit ${r.exitCode ?? "?"}`}
    />
  );
}

export const BrowserToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={browserTitle(p.args)}
    args={p.args}
    result={p.result}
    status={p.status}
    isError={p.isError}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.browsing}
    summarize={browserSummary}
  />
);

export const BrowserActionToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={browserTitle(p.args)}
    args={p.args}
    result={p.result}
    status={p.status}
    isError={p.isError}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.acting}
    summarize={browserSummary}
  />
);
