import { useState, useCallback } from "react";
import { toast } from "sonner";
import { MoreVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPlainEnter } from "@/lib/ime";
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
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { useChatTabsStore, threadUrl } from "@/features/chat/state/chatTabs";
import { ThreadRunningDot } from "@/components/ui/thread-running-dot";
import { ENGINES } from "@/config/engines";
import { ThreadLastMessageTime } from "@/components/ui/thread-last-message-time";
import { buildThreadRowActions } from "../lib/menu-actions";
import { renderMenuActions } from "./menu-kit";

export interface SidebarRowItem {
  remoteId: string;
  title?: string;
  status?: string;
  lastMessageAt?: Date | string;
  /** Engine for route selection (chat vs code surface). Null = legacy Direct. */
  engine?: string | null;
}

const ROW_CLASS =
  "group relative flex h-[var(--sidebar-row-height)] items-center gap-1 rounded-[var(--sidebar-row-radius)] pl-2 pr-1.5 text-sm transition-colors sidebar-row-surface";

/**
 * One conversation row, shared by every sidebar list (plain chats, a folder's
 * chats, search results, the archived page).
 *
 * There used to be a second implementation for folder chats, with its own copy
 * of rename / archive / delete / copy-id. Two copies of a destructive-action
 * menu is how one of them silently loses the unarchive case; this is the one
 * row now.
 *
 * The trailing box is a fixed-width slot: the relative timestamp fades out and
 * the `…` button fades in inside the SAME box, so the title never reflows when
 * the pointer moves. Rename uses a modal Dialog (not inline input) to avoid
 * blur/focus races with the context menu.
 */
export function SidebarThreadRow({
  item,
  onOpenThread,
  onMutate,
  activeId,
}: {
  item: SidebarRowItem;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
  onMutate?: () => void;
  /**
   * URL-derived active conversation. Folder rows pass this because the route,
   * not the tab store, is what placed the user inside that folder.
   */
  activeId?: string | null;
}) {
  const copy = sidebarConfig.copy;
  const openChat = useChatTabsStore((s) => s.openChat);
  const openAgent = useChatTabsStore((s) => s.openAgent);
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const title = item.title ?? "Untitled";
  const removeConversation = useDeleteConversation();

  const isActive =
    activeId !== undefined
      ? activeId === item.remoteId
      : activeKey === `chat:${item.remoteId}` || activeKey === `agent:${item.remoteId}`;

  const handleDelete = (remoteId: string) => {
    void removeConversation(remoteId)
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not delete conversation.");
      });
  };

  const handleStatusChange = (remoteId: string, next: "regular" | "archived") => {
    void setConversationStatus(remoteId, next)
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(
          err instanceof Error
            ? err.message
            : next === "archived"
              ? "Could not archive conversation."
              : "Could not unarchive conversation.",
        );
      });
  };

  const handleOpenInExplorer = useCallback(() => {
    void fetch(`/api/conversations/${encodeURIComponent(item.remoteId)}/reveal`, { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error(copy.openInExplorerFailed);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : copy.openInExplorerFailed);
      });
  }, [item.remoteId]);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

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

  const archived = item.status === "archived";

  // One list, rendered into both menus below. Adding an action here adds it to
  // the ⋯ button and the right-click together.
  const menuActions = buildThreadRowActions({
    archived,
    renameEnabled: historyConfig.renameEnabled,
    archiveEnabled: historyConfig.archiveEnabled,
    deleteEnabled: historyConfig.deleteEnabled,
    onOpen: () => (item.engine === "opencode" ? openAgent(item.remoteId) : openChat(item.remoteId)),
    onOpenInExplorer: handleOpenInExplorer,
    onRename: handleOpenRename,
    onToggleArchive: () => handleStatusChange(item.remoteId, archived ? "regular" : "archived"),
    onCopyId: () => void navigator.clipboard?.writeText(item.remoteId),
    onCopyUrl: () =>
      void navigator.clipboard?.writeText(
        `${window.location.origin}${window.location.pathname}#${threadUrl(item.remoteId, item.engine)}`,
      ),
    onDelete: () => setDeleteOpen(true),
  });

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={ROW_CLASS}
            data-active={isActive || undefined}
            aria-current={isActive ? "page" : undefined}
          >
            {(() => {
              const engineKey = item.engine === "opencode" ? "opencode" : "direct";
              const visual = ENGINES[engineKey];
              const EngineIcon = visual.icon;
              return (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none cursor-pointer"
                  onClick={() => onOpenThread(item.remoteId, item.engine ?? null)}
                >
                  <ThreadRunningDot remoteId={item.remoteId} size="sm" />
                  <EngineIcon
                    aria-hidden
                    className={cn("size-3.5 shrink-0 opacity-70", visual.badgeClass)}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                </button>
              );
            })()}

            <div className="relative flex min-w-6 shrink-0 items-center justify-end">
              <ThreadLastMessageTime
                remoteId={item.remoteId}
                fallback={item.lastMessageAt}
                className="text-2xs tabular-nums text-muted-foreground/60 transition-opacity duration-150 group-hover:opacity-0"
              />
              <div className="absolute inset-0 flex items-center justify-end opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="rounded-md p-1 text-muted-foreground hover:bg-background outline-none cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={copy.moreOptions}
                      aria-haspopup="menu"
                    >
                      <MoreVertical className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" className="z-50 min-w-40">
                    {renderMenuActions(
                      { Item: DropdownMenuItem, Separator: DropdownMenuSeparator },
                      menuActions,
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {renderMenuActions(
            { Item: ContextMenuItem, Separator: ContextMenuSeparator },
            menuActions,
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Rename dialog (modal, not inline) */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.renameTitle}</DialogTitle>
            <DialogDescription>Rename this conversation.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              // `isPlainEnter`, not `key === "Enter"`: accepting an IME candidate
              // also fires a keydown, so a bare check would commit the rename
              // with the pinyin instead of the kanji.
              if (isPlainEnter(e)) void handleConfirmRename();
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
            <Button onClick={() => void handleConfirmRename()}>{copy.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm. The menu label carries an ellipsis, so choosing it
          must not destroy the conversation in the same gesture. */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.deleteDescription(title)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleDelete(item.remoteId)}>
              {copy.deleteAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const openChat = useChatTabsStore((s) => s.openChat);
  const openAgent = useChatTabsStore((s) => s.openAgent);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleDelete = (id: string) => {
    void removeConversation(id)
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not delete conversation.");
      });
  };

  const handleUnarchive = (id: string) => {
    void setConversationStatus(id, "regular")
      .then(() => {
        onMutate?.();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Could not unarchive conversation.");
      });
  };

  // Same list behind both entry points — an archived row was the second place
  // where the two menus had drifted apart (the ⋯ omitted Copy chat ID).
  const menuActions = buildThreadRowActions({
    archived: true,
    renameEnabled: false,
    archiveEnabled: historyConfig.archiveEnabled,
    deleteEnabled: historyConfig.deleteEnabled,
    onOpen: () => (engine === "opencode" ? openAgent(remoteId) : openChat(remoteId)),
    onToggleArchive: () => handleUnarchive(remoteId),
    onCopyId: () => void navigator.clipboard?.writeText(remoteId),
    onCopyUrl: () =>
      void navigator.clipboard?.writeText(
        `${window.location.origin}${window.location.pathname}#${threadUrl(remoteId, engine)}`,
      ),
    onDelete: () => setDeleteOpen(true),
  });

  return (
    <>
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
                  className="shrink-0 rounded-md p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100 group-focus-within:opacity-100 outline-none"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" className="z-50 min-w-40">
                {renderMenuActions(
                  { Item: DropdownMenuItem, Separator: DropdownMenuSeparator },
                  menuActions,
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          {renderMenuActions(
            { Item: ContextMenuItem, Separator: ContextMenuSeparator },
            menuActions,
          )}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.deleteDescription(title || remoteId)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleDelete(remoteId)}>
              {copy.deleteAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
