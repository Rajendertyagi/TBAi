import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView } from "../filesystem/ui";
import { FieldsOrJson, ResultList, ResultRow } from "@/tools/result-fields";
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

/**
 * The `process_list` result as labelled rows, or the empty state.
 *
 * Exported for direct testing, like `dirSummary` in `../filesystem/ui`: it is
 * the only seam that decides how much of a process listing a card paints, and a
 * seam that cannot be rendered in a test is a seam nothing pins.
 *
 * @param result - `runProcesses()`'s `{ count, processes }`, unwrapped.
 * @returns Rows of `name (pid)` → `n MB`, capped at `processRowMaxRows`.
 */
export function processSummary(result: AnyResult) {
  const r = result as any;
  const list = (r?.processes ?? []) as { pid: number; name: string; cpuSeconds: number | null; memoryMB: number | null }[];
  if (list.length === 0) return <span className="text-muted-foreground">{toolsConfig.copy.status.noProcesses}</span>;
  const maxRows = toolsConfig.limits.processRowMaxRows;
  const shown = list.slice(0, maxRows);
  return (
    <ResultList
      slot="tool-result-processes"
      omitted={list.length - shown.length}
      omittedLabel={toolsConfig.copy.status.andMoreCount}
    >
      {shown.map((p) => (
        <ResultRow
          key={p.pid}
          label={`${p.name} (${p.pid})`}
          value={p.memoryMB != null ? `${p.memoryMB} MB` : undefined}
        />
      ))}
    </ResultList>
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
