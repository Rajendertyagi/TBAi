import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  Link2,
  MoreVertical,
  Palette,
  Pencil,
  SquarePen,
  Trash2,
} from "lucide-react";
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
import { useFoldersStore } from "@/stores/foldersStore";
import { useWelcomeScopeStore } from "@/features/chat/state/welcomeScope";
import type { Folder } from "@/types";

const ROW_CLASS =
  "group flex h-8 w-full items-center gap-1.5 rounded-full pl-2 pr-1 text-sm transition-colors duration-150 hover:bg-sidebar-accent";

/** Predefined folder colors (codeg parity). */
const FOLDER_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4",
  "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#ec4899", "#f43f5e",
];

/**
 * Folder header row in the sidebar's "Folders" section (codeg parity):
 * expand/collapse toggle, folder icon + alias/name label, hover-revealed
 * "+" (new conversation) and "⋯" (context menu) buttons. Context menu
 * provides: new conversation, manage links, set alias, set color, remove.
 *
 * Geometry matches `SidebarNavButton` (h-8, rounded-full, muted icon + label).
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

  // New folder chat goes through the unified draft: the folder is preset as
  // the draft scope and the user picks the engine (Direct/Code) in the one
  // creation surface, so folder flows can mint either engine. No direct
  // creation here — a second creation path is how folder chats got locked to
  // Direct.
  const handleNewConversation = useCallback(() => {
    useWelcomeScopeStore
      .getState()
      .setScope({ mode: "project", folderId: folder.id });
    navigate("/chat/new");
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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={ROW_CLASS}>
            <button
              type="button"
              onClick={() => onToggle(folder.id)}
              aria-expanded={expanded}
              className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
            >
              {expanded ? (
                <FolderOpen
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : (
                <FolderClosed
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
                {label}
              </span>
              <ChevronRight
                aria-hidden="true"
                className={`size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 ${
                  expanded ? "rotate-90" : ""
                }`}
              />
            </button>
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              title={copy.newChat}
              aria-label={copy.newChat}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/90 opacity-0 transition-opacity duration-150 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            >
              <SquarePen className="size-3.5" />
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
          <ContextMenuItem onSelect={() => void handleNewConversation()}>
            <SquarePen className="size-4" />
            {copy.newChat}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onManageLinks(folder)}>
            <Link2 className="size-4" />
            Manage links
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleOpenAlias}>
            <Pencil className="size-4" />
            Set alias
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Palette className="size-4" />
              Set color
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[12rem] p-2">
              <ContextMenuItem
                onSelect={() =>
                  void updateFolder(folder.id, { color: "#6b7280" })
                }
                className="gap-2"
              >
                <span
                  aria-hidden
                  className="size-4 shrink-0 rounded border border-border"
                  style={{ backgroundColor: "#6b7280" }}
                />
                <span className="min-w-0 flex-1 truncate">Default</span>
                {folder.color === "#6b7280" && (
                  <span className="text-xs text-muted-foreground">✓</span>
                )}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <div className="grid grid-cols-6 gap-1">
                {FOLDER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    aria-label={color}
                    onClick={() =>
                      void updateFolder(folder.id, { color })
                    }
                    className="size-5 cursor-pointer rounded-sm outline-none ring-offset-1 ring-offset-popover transition-[box-shadow,transform] duration-100 hover:scale-110 data-[active]:ring-2 data-[active]:ring-foreground/60"
                    data-active={folder.color === color ? "" : undefined}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => setRemoveOpen(true)}
          >
            <Trash2 className="size-4" />
            Remove from workspace
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Alias dialog */}
      <Dialog open={aliasOpen} onOpenChange={setAliasOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set alias</DialogTitle>
            <DialogDescription>
              A display name shown in the sidebar. Leave blank to use the folder
              name.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={aliasValue}
            onChange={(e) => setAliasValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirmAlias();
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
              &ldquo;{label}&rdquo; will be removed from your workspace.
              Conversations attached to it will stay bound and can be accessed by
              re-opening the folder.
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
