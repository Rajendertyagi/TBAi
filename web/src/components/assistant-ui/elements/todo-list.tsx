"use client";

import { LoaderIcon, CheckCircle2Icon, XCircleIcon, CircleIcon } from "lucide-react";
import type { FC } from "react";
import type { DataMessagePartProps } from "@assistant-ui/react";

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

export const TodoList: FC<Props> = ({ data }) => {
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
