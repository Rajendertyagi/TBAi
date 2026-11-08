import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ChevronRight, MoreVertical, Plus } from "lucide-react";
import { isPlainEnter } from "@/lib/ime";
import { ROUTES } from "@/config/navigation";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { sidebarConfig } from "@/config/sidebar";
import { useFoldersStore } from "@/features/folders/state/foldersStore";
import { useWelcomeScopeStore } from "@/features/chat/state/welcomeScope";
import type { Folder } from "@/types";
import { FolderTile } from "./FolderTile";
import { buildFolderMenuEntries } from "../lib/menu-actions";
import { renderFolderMenu } from "./menu-kit";

const ROW_CLASS =
  "group flex h-[var(--sidebar-row-height)] w-full items-center gap-1 rounded-[var(--sidebar-row-radius)] pl-2 pr-1 text-sm transition-colors duration-150 hover:bg-[var(--sidebar-row-hover)]";

/**
 * The trailing slot is a FIXED width. The count and the two actions share it,
 * so swapping between them never reflows the folder name — the title's box is
 * identical whether the pointer is over the row or not.
 *
 * Reveal is `group-hover` / `group-focus-within`, plus always-on for touch
 * (`hover: none`), because a hover-only control is unreachable there.
 */
const TRAILING_SLOT_CLASS =
  "relative flex h-6 w-11 shrink-0 items-center justify-end gap-0.5 text-2xs tabular-nums text-muted-foreground";
const TRAILING_ACTIONS_CLASS =
  "absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto";
const TRAILING_COUNT_CLASS =
  "pr-1 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0";
const ACTION_BUTTON_CLASS =
  "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/90 outline-none transition-colors duration-150 hover:bg-background hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Folder header row in the sidebar's "Folders" section: a colour letter tile,
 * the bold alias/name, the conversation count, and — on hover — the `+`/`⋯`
 * actions that replace the count in place.
 *
 * Context menu: new conversation, manage links, set alias, set color, remove.
 */
export function FolderHeader({
  folder,
  expanded,
  onToggle,
  onManageLinks,
}: {
  folder: Folder;
  expanded: boolean;
  onToggle: (id: string) => void;
  onManageLinks: (folder: Folder) => void;
}) {
  const navigate = useNavigate();
  const copy = sidebarConfig.copy;
  const updateFolder = useFoldersStore((s) => s.updateFolder);
  const removeFolder = useFoldersStore((s) => s.removeFolder);

  const [aliasOpen, setAliasOpen] = useState(false);
  const [aliasValue, setAliasValue] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);

  const label = folder.alias || folder.name;
  const count = folder.conversationCount ?? 0;

  // New folder chat goes through the unified draft: the folder is preset as
  // the draft scope and the user picks the engine (Direct/Code) in the one
  // creation surface, so folder flows can mint either engine. No direct
  // creation here — a second creation path is how folder chats got locked to
  // Direct.
  const handleNewConversation = useCallback(() => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: folder.id });
    navigate(ROUTES.CHAT_NEW);
  }, [folder.id, navigate]);

  const handleOpenAlias = useCallback(() => {
    setAliasValue(folder.alias ?? "");
    setAliasOpen(true);
  }, [folder.alias]);

  const handleConfirmAlias = useCallback(() => {
    const trimmed = aliasValue.trim();
    void updateFolder(folder.id, { alias: trimmed || null });
    setAliasOpen(false);
  }, [aliasValue, folder.id, updateFolder]);

  const handleRemove = useCallback(() => {
    void removeFolder(folder.id);
    setRemoveOpen(false);
  }, [folder.id, removeFolder]);

  const handleOpenInExplorer = useCallback(() => {
    void fetch(`/api/folders/${encodeURIComponent(folder.id)}/reveal`, { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error(copy.openInExplorerFailed);
      })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : copy.openInExplorerFailed);
      });
  }, [folder.id]);

  // The ⋯ button and the right-click render this same list (see menu-kit).
  const menuEntries = buildFolderMenuEntries({
    color: folder.color,
    canOpenInExplorer: true,
    onNewChat: () => void handleNewConversation(),
    onRename: handleOpenAlias,
    onPickColor: (color) => void updateFolder(folder.id, { color }),
    onManageLinks: () => onManageLinks(folder),
    onOpenInExplorer: handleOpenInExplorer,
    onCopyPath: () => void navigator.clipboard?.writeText(folder.path),
    onRemove: () => setRemoveOpen(true),
  });

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={ROW_CLASS}>
            <button
              type="button"
              onClick={() => onToggle(folder.id)}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none cursor-pointer"
            >
              <FolderTile label={label} color={folder.color} />
              <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-sidebar-foreground capitalize">
                {label}
              </span>
              <ChevronRight
                aria-hidden="true"
                className={`size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 ${
                  expanded ? "rotate-90" : ""
                }`}
              />
            </button>
            <div className={TRAILING_SLOT_CLASS}>
              {count > 0 && <span className={TRAILING_COUNT_CLASS}>{count}</span>}
              <div className={TRAILING_ACTIONS_CLASS}>
                <button
                  type="button"
                  onClick={() => void handleNewConversation()}
                  title={copy.newChat}
                  aria-label={copy.newChat}
                  className={ACTION_BUTTON_CLASS}
                >
                  <Plus className="size-3.5" />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      title={copy.moreOptions}
                      aria-label={copy.moreOptions}
                      className={ACTION_BUTTON_CLASS}
                    >
                      <MoreVertical className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" className="z-50 min-w-44">
                    {renderFolderMenu(
                      {
                        Item: DropdownMenuItem,
                        Separator: DropdownMenuSeparator,
                        Sub: DropdownMenuSub,
                        SubTrigger: DropdownMenuSubTrigger,
                        SubContent: DropdownMenuSubContent,
                      },
                      menuEntries,
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {renderFolderMenu(
            {
              Item: ContextMenuItem,
              Separator: ContextMenuSeparator,
              Sub: ContextMenuSub,
              SubTrigger: ContextMenuSubTrigger,
              SubContent: ContextMenuSubContent,
            },
            menuEntries,
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Rename dialog: sets the sidebar display name; the folder on disk keeps
          its own name, which is what the description says plainly. */}
      <Dialog open={aliasOpen} onOpenChange={setAliasOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.renameFolderTitle}</DialogTitle>
            <DialogDescription>
              A display name shown in the sidebar. The folder on disk is not renamed. Leave blank to
              use the folder name.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={aliasValue}
            onChange={(e) => setAliasValue(e.target.value)}
            onKeyDown={(e) => {
              // `isPlainEnter`, not `key === "Enter"`: accepting an IME candidate
              // also fires a keydown, so a bare check would save the folder name
              // as the pinyin instead of the kanji and close the dialog.
              if (isPlainEnter(e)) handleConfirmAlias();
            }}
            placeholder={folder.name}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAliasOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmAlias}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirm */}
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove folder?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{label}&rdquo; will be removed from your workspace. Conversations attached to
              it will stay bound and can be accessed by re-opening the folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
