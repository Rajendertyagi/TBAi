import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView, Json } from "../filesystem/ui";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

/**
 * Computer-tool renderers (processes / kill / sysinfo / shell).
 * UI-only, like the filesystem renderers: the server executes, privileged
 * actions pause at the approval gate answered via `respondToApproval()`.
 */

function processSummary(result: AnyResult) {
  const r = result as any;
  const list = (r?.processes ?? []) as { pid: number; name: string; cpuSeconds: number | null; memoryMB: number | null }[];
  if (list.length === 0) return <span className="text-muted-foreground">No processes.</span>;
  return (
    <div className="space-y-0.5">
      {list.slice(0, 30).map((p) => (
        <div key={p.pid} className="flex justify-between gap-2">
          <span className="truncate">
            {p.name} <span className="text-muted-foreground">({p.pid})</span>
          </span>
          {p.memoryMB != null && <span className="shrink-0 text-muted-foreground">{p.memoryMB} MB</span>}
        </div>
      ))}
      {list.length > 30 && <div className="text-muted-foreground">…and {list.length - 30} more</div>}
    </div>
  );
}

export const ProcessListToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title="process_list"
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Listing processes…"
    summarize={processSummary}
  />
);

export const ProcessKillToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`process_kill · ${String(p.args.pid ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Stopping process…"
    summarize={(r) => <Json value={r} />}
  />
);

export const SystemInfoToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title="system_info"
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Reading system info…"
    summarize={(r) => <Json value={r} />}
  />
);

function bashSummary(command: string) {
  return (r: AnyResult) => {
    const v = r as any;
    return (
      <div>
        <div className="mb-1 truncate text-muted-foreground">$ {command}</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
          {v?.stdout ? String(v.stdout).slice(-4000) : ""}
          {v?.stderr ? `\n--- stderr ---\n${String(v.stderr).slice(-2000)}` : ""}
          {v?.exitCode != null && v.exitCode !== 0 ? `\n(exit ${v.exitCode})` : ""}
        </pre>
      </div>
    );
  };
}

export const BashToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title="run_command"
    args={p.args}
    argPreview={
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {String(p.args.command ?? "")}
        {p.args.cwd ? `\n\n(cwd: ${String(p.args.cwd)})` : ""}
      </pre>
    }
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Running…"
    summarize={bashSummary(String(p.args.command ?? ""))}
  />
);
