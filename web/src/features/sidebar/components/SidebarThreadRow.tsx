import { useRef, useState } from "react";
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
} from "@/components/ui/context-menu";
import { historyConfig } from "@/config/history";
import { useChatTabsStore } from "@/features/chat/state/chatTabs";

export interface SidebarRowItem {
  remoteId: string;
  title?: string;
  status?: string;
}

const ROW_CLASS =
  "group relative flex items-center gap-1 rounded-full py-2 pl-3 pr-1.5 text-sm transition-colors hover:bg-sidebar-accent data-[active]:bg-sidebar-accent";

/**
 * One regular conversation row: pill geometry, inline rename, hover `…`
 * menu (rename / archive / delete per `historyConfig`) and a right-click
 * menu (open in tab, copy id). Thread switching goes through the runtime
 * trigger; routing is the caller's `onOpenThread`.
 */
export function SidebarThreadRow({
  item,
  onOpenThread,
}: {
  item: SidebarRowItem;
  onOpenThread: (remoteId: string) => void;
}) {
  const aui = useAui();
  const openChat = useChatTabsStore((s) => s.openChat);
  const title = item.title ?? "Untitled";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const submittedRef = useRef(false);

  const startRename = () => {
    submittedRef.current = false;
    setDraft(title);
    setRenaming(true);
  };

  const cancelRename = () => {
    submittedRef.current = true;
    setRenaming(false);
  };

  const commitRename = async () => {
    if (submittedRef.current || !renaming) return;
    submittedRef.current = true;
    const next = draft.trim();
    if (!next || next === title) {
      setRenaming(false);
      return;
    }
    // Through the runtime (never a raw fetch): the adapter persists AND the
    // store updates, so the title re-renders instantly. The store id is
    // resolved from state (never assumed === remoteId).
    setSaving(true);
    try {
      const items = aui.threads.getState().threadItems;
      const match =
        items.find((t) => t.remoteId === item.remoteId) ??
        items.find((t) => t.id === item.remoteId);
      await aui.threads.item({ id: match?.id ?? item.remoteId }).rename(next);
    } finally {
      setSaving(false);
      setRenaming(false);
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ThreadListItemPrimitive.Root className={ROW_CLASS}>
          {renaming ? (
            <input
              autoFocus
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") cancelRename();
              }}
              onBlur={() => void commitRename()}
              onFocus={(e) => e.target.select()}
              aria-label="Rename conversation"
              className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <ThreadListItemPrimitive.Trigger
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => onOpenThread(item.remoteId)}
            >
              <ThreadListItemPrimitive.Title />
            </ThreadListItemPrimitive.Trigger>
          )}

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
                  onSelect={() => startRename()}
                >
                  <Pencil className="size-4" /> Rename
                </ThreadListItemMorePrimitive.Item>
              )}
              {historyConfig.archiveEnabled && item.status === "regular" && (
                <ThreadListItemPrimitive.Archive asChild>
                  <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted">
                    <Archive className="size-4" /> Archive
                  </ThreadListItemMorePrimitive.Item>
                </ThreadListItemPrimitive.Archive>
              )}
              {historyConfig.deleteEnabled && (
                <ThreadListItemPrimitive.Delete asChild>
                  <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none hover:bg-muted">
                    <Trash2 className="size-4" /> Delete
                  </ThreadListItemMorePrimitive.Item>
                </ThreadListItemPrimitive.Delete>
              )}
            </ThreadListItemMorePrimitive.Content>
          </ThreadListItemMorePrimitive.Root>
        </ThreadListItemPrimitive.Root>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openChat(item.remoteId)}>
          <ExternalLink className="size-4" /> Open in New Tab
        </ContextMenuItem>
        {historyConfig.renameEnabled && (
          <ContextMenuItem onSelect={() => startRename()}>
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
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(item.remoteId)}
        >
          <Copy className="size-4" /> Copy ID
        </ContextMenuItem>
        {historyConfig.deleteEnabled && (
          <ThreadListItemPrimitive.Delete asChild>
            <ContextMenuItem variant="destructive">
              <Trash2 className="size-4" /> Delete
            </ContextMenuItem>
          </ThreadListItemPrimitive.Delete>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Archived conversation row: muted, unarchive instead of archive. */
export function SidebarArchivedRow({
  remoteId,
  onOpenThread,
}: {
  remoteId: string;
  onOpenThread: (remoteId: string) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ThreadListItemPrimitive.Root
          className={`${ROW_CLASS} text-muted-foreground`}
        >
          <ThreadListItemPrimitive.Trigger
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => onOpenThread(remoteId)}
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
                    <ArchiveRestore className="size-4" /> Unarchive
                  </ThreadListItemMorePrimitive.Item>
                </ThreadListItemPrimitive.Unarchive>
              )}
              {historyConfig.deleteEnabled && (
                <ThreadListItemPrimitive.Delete asChild>
                  <ThreadListItemMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none hover:bg-muted">
                    <Trash2 className="size-4" /> Delete
                  </ThreadListItemMorePrimitive.Item>
                </ThreadListItemPrimitive.Delete>
              )}
            </ThreadListItemMorePrimitive.Content>
          </ThreadListItemMorePrimitive.Root>
        </ThreadListItemPrimitive.Root>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {historyConfig.archiveEnabled && (
          <ThreadListItemPrimitive.Unarchive asChild>
            <ContextMenuItem>
              <ArchiveRestore className="size-4" /> Unarchive
            </ContextMenuItem>
          </ThreadListItemPrimitive.Unarchive>
        )}
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(remoteId)}
        >
          <Copy className="size-4" /> Copy ID
        </ContextMenuItem>
        {historyConfig.deleteEnabled && (
          <ThreadListItemPrimitive.Delete asChild>
            <ContextMenuItem variant="destructive">
              <Trash2 className="size-4" /> Delete
            </ContextMenuItem>
          </ThreadListItemPrimitive.Delete>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
