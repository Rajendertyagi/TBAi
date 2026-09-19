import { useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { historyConfig } from "@/config/history";
import { sidebarConfig } from "@/config/sidebar";
import { logger } from "@/lib/logger";
import { useDeleteConversation } from "@/features/chat/state/deleteConversation";
import {
  renameConversation,
  setConversationStatus,
} from "@/features/chat/state/conversationMutations";
import { useChatTabsStore } from "@/features/chat/state/chatTabs";
import { ThreadRunningDot } from "@/components/ui/thread-running-dot";

export interface SidebarRowItem {
  remoteId: string;
  title?: string;
  status?: string;
  /** Engine for route selection (chat vs code surface). Null = legacy Direct. */
  engine?: string | null;
}

const ROW_CLASS =
  "group relative flex items-center gap-1 rounded-full py-2 pl-3 pr-1.5 text-sm transition-colors hover:bg-sidebar-accent data-[active]:bg-sidebar-accent";

/**
 * One regular conversation row: pill geometry, hover `…` menu (rename /
 * archive / delete per `historyConfig`) and a right-click menu (open in tab,
 * copy id). Rename uses a modal Dialog (not inline input) to avoid
 * blur/focus race conditions with the ContextMenu. A live running dot shows
 * while the thread is generating (runtime state, never persisted).
 */
export function SidebarThreadRow({
  item,
  onOpenThread,
  onMutate,
}: {
  item: SidebarRowItem;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
  onMutate?: () => void;
}) {
  const copy = sidebarConfig.copy;
  const openChat = useChatTabsStore((s) => s.openChat);
  const openAgent = useChatTabsStore((s) => s.openAgent);
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const title = item.title ?? "Untitled";
  const removeConversation = useDeleteConversation();

  const isActive =
    activeKey === `chat:${item.remoteId}` ||
    activeKey === `agent:${item.remoteId}`;

  const handleDelete = (remoteId: string) => {
    void removeConversation(remoteId)
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : "Could not delete conversation.",
        );
      });
  };

  const handleArchive = (remoteId: string) => {
    void setConversationStatus(remoteId, "archived")
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : "Could not archive conversation.",
        );
      });
  };

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const [renameError, setRenameError] = useState<string | null>(null);

  const handleOpenRename = () => {
    setRenameValue(title);
    setRenameError(null);
    setRenameOpen(true);
  };

  const handleConfirmRename = async () => {
    const next = renameValue.trim();
    if (!next || next === title) {
      setRenameOpen(false);
      return;
    }
    try {
      await renameConversation(item.remoteId, next);
      onMutate?.();
    } catch (err) {
      logger.debug("chat", "rename_failed", {
        threadId: item.remoteId,
        errorType: err instanceof Error ? err.name : typeof err,
      });
      setRenameError(err instanceof Error ? err.message : "Rename failed");
      return;
    }
    setRenameOpen(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(ROW_CLASS, isActive && "bg-sidebar-accent")}
            data-active={isActive || undefined}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left outline-none cursor-pointer"
              onClick={() => onOpenThread(item.remoteId, item.engine ?? null)}
            >
              <span className="relative inline-flex shrink-0">
                <ThreadRunningDot
                  remoteId={item.remoteId}
                  size="sm"
                  className="absolute -left-1 -top-0.5 ring-2 ring-sidebar"
                />
              </span>
              <span className="truncate">{title}</span>
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 rounded-full p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 outline-none"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" className="z-50 min-w-40">
                {historyConfig.renameEnabled && (
                  <DropdownMenuItem onSelect={() => handleOpenRename()}>
                    <Pencil className="size-4" /> {copy.rename}
                  </DropdownMenuItem>
                )}
                {historyConfig.archiveEnabled && item.status === "regular" && (
                  <DropdownMenuItem onSelect={() => handleArchive(item.remoteId)}>
                    <Archive className="size-4" /> {copy.archive}
                  </DropdownMenuItem>
                )}
                {historyConfig.deleteEnabled && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => handleDelete(item.remoteId)}
                  >
                    <Trash2 className="size-3.5" /> {copy.delete}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() =>
              item.engine === "opencode"
                ? openAgent(item.remoteId)
                : openChat(item.remoteId)
            }
          >
            <ExternalLink className="size-4" /> {copy.openInNewTab}
          </ContextMenuItem>
          {historyConfig.renameEnabled && (
            <ContextMenuItem onSelect={() => handleOpenRename()}>
              <Pencil className="size-4" /> Rename
            </ContextMenuItem>
          )}
          {historyConfig.archiveEnabled && item.status === "regular" && (
            <ContextMenuItem onSelect={() => handleArchive(item.remoteId)}>
              <Archive className="size-4" /> Archive
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void navigator.clipboard?.writeText(item.remoteId)}
          >
            <Copy className="size-4" /> {copy.copyId}
          </ContextMenuItem>
          {historyConfig.deleteEnabled && (
            <ContextMenuItem
              variant="destructive"
              onSelect={() => handleDelete(item.remoteId)}
            >
              <Trash2 className="size-4" /> Delete
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Rename dialog (modal, not inline) */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.rename}</DialogTitle>
            <DialogDescription>Rename this conversation.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConfirmRename();
            }}
            placeholder={title}
            autoFocus
          />
          {renameError && (
            <p role="alert" className="text-xs text-destructive">
              {renameError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {copy.cancel}
            </Button>
            <Button onClick={() => void handleConfirmRename()}>
              {copy.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Archived conversation row: muted, unarchive instead of archive. */
export function SidebarArchivedRow({
  remoteId,
  title,
  engine,
  onOpenThread,
  onMutate,
}: {
  remoteId: string;
  title?: string;
  engine?: string | null;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
  onMutate?: () => void;
}) {
  const copy = sidebarConfig.copy;
  const removeConversation = useDeleteConversation();

  const handleDelete = (id: string) => {
    void removeConversation(id)
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : "Could not delete conversation.",
        );
      });
  };

  const handleUnarchive = (id: string) => {
    void setConversationStatus(id, "regular")
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error ? err.message : "Could not unarchive conversation.",
        );
      });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn(ROW_CLASS, "text-muted-foreground")}>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left outline-none cursor-pointer"
            onClick={() => onOpenThread(remoteId, engine ?? null)}
          >
            <span className="truncate">{title || remoteId}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 outline-none"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" className="z-50 min-w-40">
              {historyConfig.archiveEnabled && (
                <DropdownMenuItem onSelect={() => handleUnarchive(remoteId)}>
                  <ArchiveRestore className="size-4" /> {copy.unarchive}
                </DropdownMenuItem>
              )}
              {historyConfig.deleteEnabled && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => handleDelete(remoteId)}
                >
                  <Trash2 className="size-3.5" /> {copy.delete}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {historyConfig.archiveEnabled && (
          <ContextMenuItem onSelect={() => handleUnarchive(remoteId)}>
            <ArchiveRestore className="size-4" /> {copy.unarchive}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(remoteId)}
        >
          <Copy className="size-4" /> {copy.copyId}
        </ContextMenuItem>
        {historyConfig.deleteEnabled && (
          <ContextMenuItem
            variant="destructive"
            onSelect={() => handleDelete(remoteId)}
          >
            <Trash2 className="size-4" /> Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
