import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView, Json } from "../filesystem/ui";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

/**
 * Renderer for the six AI-controlled scheduler tools (create/list/get/update/
 * delete/run). UI-only — execution happens server-side (the AISDKToolkit
 * `execute`), exactly like the filesystem and computer tools. The result is a
 * JSON summary, so a single card component covers all six.
 */
export const SchedulerToolUI: ToolCallMessagePartComponent = (p: AnyProps) => {
  const label =
    String(p.args.name ?? p.args.id ?? "").trim() ||
    (p.args.prompt ? "scheduler job" : "scheduler");
  return (
    <BackendToolView
      title={`scheduler · ${label}`}
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
