"use client";

import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Folder } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useFoldersStore } from "@/stores/foldersStore";
import { welcomeConfig } from "@/config/welcome";

/**
 * Conversation identity fields this row consumes. These are the P1-extended
 * `custom` bag fields (engine / opencodeAgent / opencodeModel) plus the
 * pre-existing workspace scope fields (workspaceMode / workspaceFolderId) —
 * the same data `toMetadata` surfaces as `threadListItem.custom`.
 */
type ConversationIdentity = {
  engine?: "direct" | "opencode";
  workspaceMode?: "simple" | "project";
  workspaceFolderId?: string | null;
  opencodeAgent?: string | null;
  opencodeModel?: string | null;
  opencodeVariant?: string | null;
};

const ENGINE_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  direct: "Direct",
};

/**
 * Reads the bound conversation's identity (engine / scope / agent / model) from
 * the conversation record. The OpenCode view runs inside the OpenCode runtime,
 * whose `threadListItem.custom` is session-scoped and does not carry these
 * conversation fields — so we read the same source `toMetadata` maps into
 * `custom` (the conversation record) by id.
 */
function useConversationIdentity(conversationId: string | undefined) {
  const [identity, setIdentity] = useState<ConversationIdentity | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    fetch(`/api/conversations/${conversationId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setIdentity({
          engine: data.engine,
          workspaceMode: data.workspaceMode,
          workspaceFolderId: data.workspaceFolderId,
          opencodeAgent: data.opencodeAgent,
          opencodeModel: data.opencodeModel,
          opencodeVariant: data.opencodeVariant,
        });
      })
      .catch(() => {
        /* leave identity null → render nothing */
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);
  return identity;
}

/**
 * Static, non-editable session-identity row for Code mode: engine badge +
 * scope chip (folder name or chat mode) + agent/model names. Scope/agent/model
 * are locked at creation (changing them means a new chat), so this is display
 * only. Agent/model may be absent for pre-P1 sessions → neutral dash fallback.
 * Mounted as a sibling of ChatWindow (never inside it).
 */
export function OpenCodeSessionRow() {
  const { agentId } = useParams();
  const identity = useConversationIdentity(agentId);
  const folders = useFoldersStore((s) => s.folders);
  const loadFolders = useFoldersStore((s) => s.loadFolders);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  if (!identity) return null;

  const engineLabel =
    ENGINE_LABELS[identity.engine ?? ""] ?? identity.engine ?? "OpenCode";
  const isProject = identity.workspaceMode === "project";
  const folder =
    isProject && identity.workspaceFolderId
      ? folders.find((f) => f.id === identity.workspaceFolderId) ?? null
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
        {identity.opencodeAgent ? (
          identity.opencodeAgent
        ) : (
          <span className="text-muted-foreground/60">–</span>
        )}
      </span>
      <span className="truncate">
        Model:{" "}
        {identity.opencodeModel ? (
          identity.opencodeModel
        ) : (
          <span className="text-muted-foreground/60">–</span>
        )}
      </span>
      {identity.opencodeVariant && (
        <span className="truncate">
          Thinking: <span className="text-muted-foreground/60">{identity.opencodeVariant}</span>
        </span>
      )}
    </div>
  );
}
