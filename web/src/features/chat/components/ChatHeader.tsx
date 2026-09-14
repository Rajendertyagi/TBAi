import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  EllipsisVertical,
  Pencil,
  SquarePen,
  Trash2,
} from "lucide-react";
import { chatHeaderConfig } from "@/config/sidebar";
import { historyConfig } from "@/config/history";
import { NEW_DRAFT_TAB_ID } from "@/features/chat/state/chatTabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
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

/**
 * Conversation breadcrumb header (chat routes only): workspace root crumb ›
 * chat title on the left, an overflow (⋯) menu on the right. Transparent —
 * reads as part of the message canvas, not a chrome band (codeg
 * `ConversationDetailHeader` parity, minus folder/pin/status concepts this
 * app doesn't have).
 *
 * Subscriptions are narrow primitives (title string, status string) so
 * streaming tokens never re-render it. Dialog targets are snapshotted at
 * open time, so a mid-dialog tab switch can't retarget the confirm.
 */
export function ChatHeader({ threadId }: { threadId: string }) {
  const copy = chatHeaderConfig.copy;
  const navigate = useNavigate();
  const aui = useAui();
  const isDraft = threadId === NEW_DRAFT_TAB_ID;

  const [rootName, setRootName] = useState(copy.workspaceFallback);
  const [rootHref, setRootHref] = useState("/workspace");
  useEffect(() => {
    let cancelled = false;
    // Draft (pre-creation) chat: nothing is persisted yet — show the default.
    if (isDraft) {
      setRootHref("/workspace");
      fetch("/api/workspace")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data?.name) setRootName(data.name);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    // Existing conversation: derive the crumb from its workspace mode.
    fetch(`/api/conversations/${threadId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((conv) => {
        if (cancelled || !conv) return;
        if (conv.workspaceMode === "project" && conv.workspaceFolderId) {
          setRootHref("/folders");
          return fetch(`/api/folders/${conv.workspaceFolderId}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((f) => {
              if (cancelled) return;
              setRootName(f ? (f.alias || f.name) : "Project (folder removed)");
            })
            .catch(() => {});
        }
        setRootHref("/workspace");
        setRootName(copy.temporaryWorkspace);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [threadId, isDraft, copy.workspaceFallback, copy.temporaryWorkspace]);

  // Narrow primitive reads: re-render only when THIS thread's title/status
  // change, never on streaming tokens or other threads' updates.
  const title = useAuiState((s) => {
    if (isDraft) return copy.newChatTitle;
    const item = s.threads.threadItems.find(
      (t) => t.remoteId === threadId || t.id === threadId,
    );
    return (item?.title as string | undefined) ?? copy.untitled;
  });
  const status = useAuiState((s) => {
    if (isDraft) return "draft";
    const item = s.threads.threadItems.find(
      (t) => t.remoteId === threadId || t.id === threadId,
    );
    return item?.status ?? "regular";
  });

  // Snapshot the action target when a dialog OPENS (not at confirm time).
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const resolveStoreId = (): string | null => {
    const items = aui.threads.getState().threadItems;
    const match =
      items.find((t) => t.remoteId === threadId) ??
      items.find((t) => t.id === threadId);
    return match?.id ?? match?.remoteId ?? null;
  };

  const handleNewChat = () => navigate("/chat/new");

  const handleRenameOpen = () => {
    const id = resolveStoreId();
    if (!id) return;
    setRenameValue(title);
    setRenameTarget({ id, title });
  };

  const handleRenameConfirm = async () => {
    if (!renameTarget) return;
    const next = renameValue.trim();
    if (next && next !== renameTarget.title) {
      await aui.threads.item({ id: renameTarget.id }).rename(next);
    }
    setRenameTarget(null);
  };

  const handleArchiveToggle = () => {
    const id = resolveStoreId();
    if (!id) return;
    const item = aui.threads.item({ id });
    if (status === "archived") void item.unarchive();
    else void item.archive();
  };

  const handleCopyId = () => {
    void navigator.clipboard?.writeText(threadId);
  };

  const handleDeleteOpen = () => {
    const id = resolveStoreId();
    if (!id) return;
    setDeleteTarget({ id, title });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await aui.threads.item({ id: deleteTarget.id }).delete();
    setDeleteTarget(null);
  };

  return (
    <div className="flex h-[var(--title-bar-height)] shrink-0 items-center gap-2 border-b border-border/50 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <button
          type="button"
          onClick={() => navigate(rootHref)}
          title={rootName}
          className="shrink-0 truncate rounded text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {rootName}
        </button>
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground/50"
        />
        {/* Title absorbs remaining width and takes the ellipsis; the root
            crumb stays fully visible. */}
        <span
          className="min-w-0 flex-1 truncate text-sm text-foreground/90"
          title={title}
        >
          {title}
        </span>
      </div>
      <div className="flex shrink-0 items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={copy.moreActions}
              title={copy.moreActions}
              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              <EllipsisVertical aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={handleNewChat}>
              <SquarePen className="size-4" />
              {copy.newConversation}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {historyConfig.renameEnabled && (
              <DropdownMenuItem disabled={isDraft} onSelect={handleRenameOpen}>
                <Pencil className="size-4" />
                {copy.rename}
              </DropdownMenuItem>
            )}
            {historyConfig.archiveEnabled && !isDraft && (
              <DropdownMenuItem onSelect={handleArchiveToggle}>
                {status === "archived" ? (
                  <ArchiveRestore className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )}
                {status === "archived" ? copy.unarchive : copy.archive}
              </DropdownMenuItem>
            )}
            {!isDraft && (
              <DropdownMenuItem onSelect={handleCopyId}>
                <Copy className="size-4" />
                {copy.copyId}
              </DropdownMenuItem>
            )}
            {historyConfig.deleteEnabled && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={isDraft}
                  onSelect={handleDeleteOpen}
                >
                  <Trash2 className="size-4" />
                  {copy.delete}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog
        open={renameTarget != null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.renameTitle}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRenameConfirm();
            }}
            autoFocus
            aria-label={copy.renameTitle}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {copy.cancel}
            </Button>
            <Button onClick={() => void handleRenameConfirm()}>
              {copy.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.deleteDescription(deleteTarget?.title ?? "")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteConfirm()}>
              {copy.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
