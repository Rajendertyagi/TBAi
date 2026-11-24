"use client";

import { useEffect } from "react";
import { Folder } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useFoldersStore } from "@/features/folders/state/foldersStore";
import { welcomeConfig } from "@/config/welcome";
import { useOpenCodeRuntimeContext } from "./opencodeRuntimeContext";

const ENGINE_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  direct: "Direct",
};

/**
 * Static, non-editable session-identity row for Code mode: engine badge +
 * scope chip (folder name or chat mode) + agent/model names. Scope/agent/model
 * are locked at creation (changing them means a new chat), so this is display
 * only. Agent/model may be absent for pre-P1 sessions → neutral dash fallback.
 * Mounted as a sibling of ChatWindow (never inside it).
 *
 * Identity comes from the single conversation config fetched by the activated
 * host and shared through `OpenCodeRuntimeContext` — this row issues no
 * conversation probe of its own. `null` config (read in flight or failed)
 * renders nothing, matching the previous probe's non-`exists` behavior.
 */
export function OpenCodeSessionRow() {
  const runtime = useOpenCodeRuntimeContext();
  const config = runtime?.config ?? null;
  const folders = useFoldersStore((s) => s.folders);
  const ensureFoldersLoaded = useFoldersStore((s) => s.ensureFoldersLoaded);

  useEffect(() => {
    void ensureFoldersLoaded();
  }, [ensureFoldersLoaded]);

  if (!config) return null;

  const engineLabel = ENGINE_LABELS[config.engine] ?? "OpenCode";
  const isProject = config.workspaceMode === "project";
  const folder =
    isProject && config.workspaceFolderId
      ? (folders.find((f) => f.id === config.workspaceFolderId) ?? null)
      : null;
  const scopeLabel = isProject
    ? folder?.alias || folder?.name || welcomeConfig.copy.folderRemoved
    : welcomeConfig.copy.chatModeLabel;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
      <Badge variant="outline" className="gap-1">
        {engineLabel}
      </Badge>
      <span className="flex min-w-0 items-center gap-1">
        <Folder aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{scopeLabel}</span>
      </span>
      <span className="truncate">
        Agent:{" "}
        {config.opencodeAgent ? (
          config.opencodeAgent
        ) : (
          <span className="text-muted-foreground/60">–</span>
        )}
      </span>
      <span className="truncate">
        Model:{" "}
        {config.opencodeModel ? (
          config.opencodeModel
        ) : (
          <span className="text-muted-foreground/60">–</span>
        )}
      </span>
      {config.opencodeVariant && (
        <span className="truncate">
          Thinking: <span className="text-muted-foreground/60">{config.opencodeVariant}</span>
        </span>
      )}
    </div>
  );
}
