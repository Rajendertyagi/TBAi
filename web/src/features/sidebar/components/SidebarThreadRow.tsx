import { useState } from "react";
import { toast } from "sonner";
import {
  ThreadListItemPrimitive,
  ThreadListItemMorePrimitive,
  useAui,
} from "@assistant-ui/react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
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
}: {
  item: SidebarRowItem;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const aui = useAui();
  const copy = sidebarConfig.copy;
  const openChat = useChatTabsStore((s) => s.openChat);
  const openAgent = useChatTabsStore((s) => s.openAgent);
  const title = item.title ?? "Untitled";
  const removeConversation = useDeleteConversation();

  // Full deletion lifecycle (server → runtime → tabs → route via TabUrlSync).
  // Failures surface as a toast; nothing is removed when the server refuses.
  const handleDelete = (remoteId: string) => {
    void removeConversation(remoteId).catch((err: unknown) => {
      toast.error(
        err instanceof Error ? err.message : "Could not delete conversation.",
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
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === item.remoteId) ??
        items.find((t) => t.id === item.remoteId);
      await aui.threads.item({ id: match?.id ?? item.remoteId }).rename(next);
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
          <ThreadListItemPrimitive.Root className={ROW_CLASS}>
            <ThreadListItemPrimitive.Trigger
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => onOpenThread(item.remoteId, item.engine ?? null)}
            >
              <span className="relative inline-flex shrink-0">
                <ThreadRunningDot
                  remoteId={item.remoteId}
                  size="sm"
                  className="absolute -left-1 -top-0.5 ring-2 ring-sidebar"
                />
              </span>
              <ThreadListItemPrimitive.Title />
            </ThreadListItemPrimitive.Trigger>

            <ThreadListItemMorePrimitive.Root>
              <ThreadListItemMorePrimitive.Trigger
                className="shrink-0 rounded-full p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="size-4" />
              </ThreadListItemMorePrimitive.Trigger>
              <ThreadListItemMorePrimitive.Content className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                {historyConfig.renameEnabled && (
                  <ThreadListItemMorePrimitive.Item
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted"
                    onSelect={() => handleOpenRename()}
                  >
                    <Pencil className="size-4" /> {copy.rename}
                  </ThreadListItemMorePrimitive.Item>
                )}
                {historyConfig.archiveEnabled && item.status === "regular" && (
                  <ThreadListItemPrimitive.Archive asChild>
                    <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted">
                      <Archive className="size-4" /> {copy.archive}
                    </ThreadListItemMorePrimitive.Item>
                  </ThreadListItemPrimitive.Archive>
                )}
                {historyConfig.deleteEnabled && (
                  <ThreadListItemMorePrimitive.Item
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none hover:bg-muted"
                    onSelect={() => handleDelete(item.remoteId)}
                  >
                    <Trash2 className="size-3.5" /> {copy.delete}
                  </ThreadListItemMorePrimitive.Item>
                )}
              </ThreadListItemMorePrimitive.Content>
            </ThreadListItemMorePrimitive.Root>
          </ThreadListItemPrimitive.Root>
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
            <ThreadListItemPrimitive.Archive asChild>
              <ContextMenuItem>
                <Archive className="size-4" /> Archive
              </ContextMenuItem>
            </ThreadListItemPrimitive.Archive>
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
  engine,
  onOpenThread,
}: {
  remoteId: string;
  engine?: string | null;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const copy = sidebarConfig.copy;
  const removeConversation = useDeleteConversation();

  const handleDelete = (id: string) => {
    void removeConversation(id).catch((err: unknown) => {
      toast.error(
        err instanceof Error ? err.message : "Could not delete conversation.",
      );
    });
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ThreadListItemPrimitive.Root
          className={`${ROW_CLASS} text-muted-foreground`}
        >
          <ThreadListItemPrimitive.Trigger
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => onOpenThread(remoteId, engine ?? null)}
          >
            <ThreadListItemPrimitive.Title />
          </ThreadListItemPrimitive.Trigger>
          <ThreadListItemMorePrimitive.Root>
            <ThreadListItemMorePrimitive.Trigger
              className="shrink-0 rounded-full p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="size-4" />
            </ThreadListItemMorePrimitive.Trigger>
            <ThreadListItemMorePrimitive.Content className="z-50 min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              {historyConfig.archiveEnabled && (
                <ThreadListItemPrimitive.Unarchive asChild>
                  <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted">
                    <ArchiveRestore className="size-4" /> {copy.unarchive}
                  </ThreadListItemMorePrimitive.Item>
                </ThreadListItemPrimitive.Unarchive>
              )}
              {historyConfig.deleteEnabled && (
                <ThreadListItemMorePrimitive.Item
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none hover:bg-muted"
                  onSelect={() => handleDelete(remoteId)}
                >
                  <Trash2 className="size-3.5" /> {copy.delete}
                </ThreadListItemMorePrimitive.Item>
              )}
            </ThreadListItemMorePrimitive.Content>
          </ThreadListItemMorePrimitive.Root>
        </ThreadListItemPrimitive.Root>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {historyConfig.archiveEnabled && (
          <ThreadListItemPrimitive.Unarchive asChild>
            <ContextMenuItem>
              <ArchiveRestore className="size-4" /> {copy.unarchive}
            </ContextMenuItem>
          </ThreadListItemPrimitive.Unarchive>
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
