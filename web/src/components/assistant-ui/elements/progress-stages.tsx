"use client";

import { LoaderIcon, CheckCircle2Icon, XCircleIcon, CircleIcon } from "lucide-react";
import type { FC } from "react";
import type { DataMessagePartProps } from "@assistant-ui/react";

/**
 * Renders TBAi's own `data-tbai-progress` stream part: the agent's *progress*.
 *
 * ## This is not a todo list, and it used to be called one
 *
 * The component was `TodoList` in `todo-list.tsx`, which was wrong in a way that
 * mattered. It renders **stages the server derives by aggregating tool calls into
 * semantic categories** — `list_dir` + `search_files` + `file_info` all collapse
 * into one "Inspecting workspace" row, per `TOOL_STAGE_MAP` in
 * `src/lib/progress-stages.ts`. Nothing here comes from a task list, and nothing
 * here is a plan the model authored.
 *
 * The name caused a concrete error: a tool-UI audit counted "three separate
 * designs for one feature" for todo lists, on the strength of this file plus
 * OpenCode's two genuinely-todo renderers. The misnomer survived long enough to be
 * written down as a finding, so it is recorded here rather than only corrected.
 *
 * Those two OpenCode renderers no longer exist. Both read `todowrite`, and
 * OpenCode v2 deleted that tool — the string occurs zero times in the shipped
 * `opencode.exe`. `OpenCodeTodoWriteToolUI` and the Code dock's
 * `OpenCodeTodoTracker` are both gone, so what is left is **this progress
 * renderer and the NATIVE `todo` tool's card**, which is a different thing on a
 * different surface. Do not look for the missing two: they were cards for a tool
 * that no longer exists. See `docs/tool-ui-tracker.md`.
 *
 * The second reason the old name was wrong, and the one that still holds: the
 * Direct surface's only todo source is its own native `todo` tool, and nothing
 * here is a plan the model authored — the stages are derived server-side by
 * aggregating tool calls. Neither is this file.
 */
export type ProgressStage = {
  id: string;
  label: string;
  status: "pending" | "active" | "completed" | "failed";
};

export type ProgressData = {
  kind: "tbai-progress";
  version: 1;
  stages: ProgressStage[];
};

type Props = DataMessagePartProps<ProgressData>;

const statusIcon = (status: ProgressStage["status"]) => {
  switch (status) {
    case "active":
      return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
    case "completed":
      return <CheckCircle2Icon className="h-3.5 w-3.5 text-green-500" />;
    case "failed":
      return <XCircleIcon className="h-3.5 w-3.5 text-red-500" />;
    default:
      return <CircleIcon className="h-3.5 w-3.5 text-muted-foreground/40" />;
  }
};

export const ProgressStages: FC<Props> = ({ data }) => {
  const stages: ProgressStage[] = data.stages;
  if (!stages.length) return null;

  const activeCount = stages.filter((s: ProgressStage) => s.status === "active").length;
  const totalCount = stages.length;

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/30 p-2.5 text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
        <span className="font-medium text-foreground">Agent progress</span>
        <span className="ml-auto text-[10px] tabular-nums">
          {activeCount > 0 ? `${activeCount}/${totalCount} active` : `${totalCount} steps`}
        </span>
      </div>
      <ul className="space-y-1">
        {stages.map((stage: ProgressStage) => (
          <li
            key={stage.id}
            className={`flex items-center gap-2 ${
              stage.status === "completed" ? "text-muted-foreground/60" : ""
            }`}
          >
            <span className="shrink-0">{statusIcon(stage.status)}</span>
            <span
              className={
                stage.status === "completed"
                  ? "line-through text-muted-foreground/60"
                  : stage.status === "failed"
                    ? "text-red-500"
                    : ""
              }
            >
              {stage.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
