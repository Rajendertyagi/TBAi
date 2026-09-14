import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView, Json } from "../filesystem/ui";

type SchedulerArgs = {
  action: string;
  jobId?: string;
  name?: string;
  [key: string]: unknown;
};
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<SchedulerArgs, AnyResult>;

/**
 * Single renderer for the `scheduler` AI tool (action-dispatched: create /
 * list / get / update / delete / run_now). UI-only — execution happens
 * server-side (the AISDKToolkit `execute`), like the filesystem and computer
 * tools. The result is a uniform JSON envelope, so one card covers every
 * action.
 */
export const SchedulerToolUI: ToolCallMessagePartComponent = (p: AnyProps) => {
  const action = String(p.args?.action ?? "scheduler");
  const label =
    String(p.args?.name ?? p.args?.jobId ?? "").trim() || "scheduler";
  return (
    <BackendToolView
      title={`scheduler · ${action} · ${label}`}
      args={p.args}
      result={p.result}
      status={p.status}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel="Working…"
      summarize={(r) => <Json value={r} />}
    />
  );
};
