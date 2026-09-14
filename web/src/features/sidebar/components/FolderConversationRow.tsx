import { memo, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  MessageSquare,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
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
import { cn } from "@/lib/utils";
import { sidebarConfig } from "@/config/sidebar";
import { historyConfig } from "@/config/history";
import { useChatTabsStore } from "@/features/chat/state/chatTabs";
import { ThreadRunningDot } from "@/components/ui/thread-running-dot";

const ROW_CLASS =
  "group flex h-8 w-full items-center gap-1.5 rounded-full pl-6 pr-1 text-sm transition-colors duration-150 hover:bg-sidebar-accent";

/**
 * Standalone conversation row rendered under a folder header in the sidebar's
 * "Folders" section. Reads from the assistant-ui runtime's thread items,
 * filtered by `custom.workspaceFolderId`. Full conversation management:
 * context menu (rename, archive/unarchive, delete, copy ID), hover actions,
 * live running dot (runtime state), rename dialog.
 *
 * Does NOT use `ThreadListItemPrimitive` — reads from `useAuiState` directly
 * and handles all actions through the runtime adapter + fetch PATCH.
 */
export const FolderConversationRow = memo(function FolderConversationRow({
  folderId,
  activeId,
}: {
  folderId: string;
  activeId: string | null;
}) {
  const items = useAuiState((s) => s.threads.threadItems);

  const folderConvs = useMemo(
    () =>
      items.filter(
        (t) =>
          t.custom?.workspaceFolderId === folderId &&
          t.status !== "archived",
      ),
    [items, folderId],
  );

  if (folderConvs.length === 0) {
    return (
      <div className="flex h-8 items-center pl-6 pr-1 text-xs text-muted-foreground">
        No conversations
      </div>
    );
  }

  return (
    <>
      {folderConvs.map((item) => {
        const id = item.remoteId ?? item.id;
        return (
          <FolderConvRow
            key={id}
            remoteId={id}
            title={item.title ?? "Untitled"}
            status={item.status}
            isActive={activeId === id}
          />
        );
      })}
    </>
  );
});

/**
 * Single conversation row inside a folder. Owns its own rename/delete
 * state so the parent list doesn't re-render on every action.
 */
const FolderConvRow = memo(function FolderConvRow({
  remoteId,
  title: initialTitle,
  status: rawStatus,
  isActive,
}: {
  remoteId: string;
  title: string;
  status: string;
  isActive: boolean;
}) {
  const navigate = useNavigate();
  const aui = useAui();
  const openChat = useChatTabsStore((s) => s.openChat);
  const copy = sidebarConfig.copy;

  // Persistent status is binary (regular/archived) and comes straight from
  // the runtime — no mapping layer. Generation activity is shown separately
  // via the runtime-derived running dot.
  const status = rawStatus === "archived" ? "archived" : "regular";

  // Rename dialog state (modal Dialog, not inline input — avoids blur/focus
  // race conditions with the ContextMenu).
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(initialTitle);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleOpenRename = useCallback(() => {
    setRenameValue(initialTitle);
    setRenameOpen(true);
  }, [initialTitle]);

  const handleConfirmRename = useCallback(async () => {
    const next = renameValue.trim();
    if (!next || next === initialTitle) {
      setRenameOpen(false);
      return;
    }
    try {
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === remoteId) ??
        items.find((t) => t.id === remoteId);
      await aui.threads.item({ id: match?.id ?? remoteId }).rename(next);
    } catch {
      /* best effort */
    }
    setRenameOpen(false);
  }, [renameValue, initialTitle, remoteId, aui]);

  const handleArchiveToggle = useCallback(async () => {
    try {
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === remoteId) ??
        items.find((t) => t.id === remoteId);
      const id = match?.id ?? remoteId;
      if (status === "archived") {
        await aui.threads.item({ id }).unarchive();
      } else {
        await aui.threads.item({ id }).archive();
      }
    } catch {
      /* best effort */
    }
  }, [remoteId, aui, status]);

  const handleDelete = useCallback(async () => {
    try {
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === remoteId) ??
        items.find((t) => t.id === remoteId);
      await aui.threads.item({ id: match?.id ?? remoteId }).delete();
    } catch {
      /* best effort */
    }
    setDeleteOpen(false);
  }, [remoteId, aui]);

  const handleCopyId = useCallback(() => {
    void navigator.clipboard?.writeText(remoteId);
  }, [remoteId]);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={cn(ROW_CLASS, isActive && "bg-sidebar-accent")}>
            <button
              type="button"
              onClick={() => navigate(`/chat/${remoteId}`)}
              className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
            >
              <span className="relative shrink-0">
                <MessageSquare
                  aria-hidden="true"
                  className="size-3.5 text-muted-foreground"
                />
                <ThreadRunningDot
                  remoteId={remoteId}
                  size="xs"
                  className="absolute -right-0.5 -bottom-0.5 ring-2 ring-sidebar"
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">
                {initialTitle}
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                e.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: rect.left,
                    clientY: rect.bottom,
                  }),
                );
              }}
              title="More options"
              aria-label="More options"
              aria-haspopup="menu"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/90 opacity-0 transition-opacity duration-150 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => openChat(remoteId)}>
            <ExternalLink className="size-4" />
            {copy.openInNewTab}
          </ContextMenuItem>
          {historyConfig.renameEnabled && (
            <ContextMenuItem onSelect={handleOpenRename}>
              <Pencil className="size-4" />
              {copy.rename}
            </ContextMenuItem>
          )}
          {historyConfig.archiveEnabled && (
            <>
              <ContextMenuSeparator />
              {status === "regular" ? (
                <ContextMenuItem onSelect={() => void handleArchiveToggle()}>
                  <Archive className="size-4" />
                  {copy.archive}
                </ContextMenuItem>
              ) : (
                <ContextMenuItem onSelect={() => void handleArchiveToggle()}>
                  <ArchiveRestore className="size-4" />
                  {copy.unarchive}
                </ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleCopyId}>
            <Copy className="size-4" />
            {copy.copyId}
          </ContextMenuItem>
          {historyConfig.deleteEnabled && (
            <ContextMenuItem
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              {copy.delete}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Rename dialog (modal, not inline — avoids blur/focus race with ContextMenu) */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.rename}</DialogTitle>
            <DialogDescription>
              Rename this conversation.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConfirmRename();
            }}
            placeholder={initialTitle}
            autoFocus
          />
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

      {/* Delete confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.deleteDescription(initialTitle)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>
              {copy.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});
