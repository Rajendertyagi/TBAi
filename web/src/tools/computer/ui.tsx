import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView } from "../filesystem/ui";
import { FieldsOrJson } from "@/tools/result-fields";
import { toolsConfig } from "@/config/tools";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

/**
 * Computer-tool renderers (processes / kill / sysinfo).
 *
 * `run_command` moved to the official assistant-ui Terminal Block
 * (`./terminal-ui.tsx`). UI-only, like the filesystem renderers: the server
 * executes, privileged actions pause at the approval gate answered via
 * `respondToApproval()`.
 */

function processSummary(result: AnyResult) {
  const r = result as any;
  const list = (r?.processes ?? []) as { pid: number; name: string; cpuSeconds: number | null; memoryMB: number | null }[];
  if (list.length === 0) return <span className="text-muted-foreground">{toolsConfig.copy.status.noProcesses}</span>;
  const maxRows = toolsConfig.limits.processRowMaxRows;
  return (
    <div className="space-y-0.5">
      {list.slice(0, maxRows).map((p) => (
        <div key={p.pid} className="flex justify-between gap-2">
          <span className="truncate">
            {p.name} <span className="text-muted-foreground">({p.pid})</span>
          </span>
          {p.memoryMB != null && <span className="shrink-0 text-muted-foreground">{p.memoryMB} MB</span>}
        </div>
      ))}
      {list.length > maxRows && <div className="text-muted-foreground">{toolsConfig.copy.status.andMoreCount(list.length - maxRows)}</div>}
    </div>
  );
}

export const ProcessListToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title="process_list"
    args={p.args}
    result={p.result}
    status={p.status}
    isError={p.isError}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.listingProcesses}
    summarize={processSummary}
  />
);

export const ProcessKillToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`process_kill · ${String(p.args.pid ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    isError={p.isError}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.stoppingProcess}
    summarize={(r) => <FieldsOrJson value={r} />}
  />
);

export const SystemInfoToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title="system_info"
    args={p.args}
    result={p.result}
    status={p.status}
    isError={p.isError}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel={toolsConfig.copy.running.readingSystemInfo}
    summarize={(r) => <FieldsOrJson value={r} />}
  />
);
