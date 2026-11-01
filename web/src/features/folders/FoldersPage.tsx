import { useEffect, useState } from "react";
import { FolderPlus, Link2, Pencil, Palette, FolderInput, Trash2, Layers } from "lucide-react";
import { SettingsPage, SettingsSection, SettingsError } from "@/components/shared/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useFoldersStore } from "@/features/folders/state/foldersStore";
import { WorkspaceFolderDialog } from "./WorkspaceFolderDialog";
import { FolderTile } from "@/features/sidebar/components/FolderTile";
import { FOLDER_COLORS, DEFAULT_FOLDER_COLOR } from "@/features/sidebar/lib/folder-colors";
import { sidebarConfig } from "@/config/sidebar";
import { isPlainEnter } from "@/lib/ime";
import type { Folder } from "@/types";

/**
 * Folders settings surface. Register/manage project folders,
 * their linked/allowed paths, groups, alias and color.
 * Modernized to use shadcn Dialog and AlertDialog instead of native prompts.
 */
export function FoldersPage() {
  const folders = useFoldersStore((s) => s.folders);
  const groups = useFoldersStore((s) => s.folderGroups);
  const loadFolders = useFoldersStore((s) => s.loadFolders);
  const loadGroups = useFoldersStore((s) => s.loadGroups);
  const updateFolder = useFoldersStore((s) => s.updateFolder);
  const removeFolder = useFoldersStore((s) => s.removeFolder);
  const createGroup = useFoldersStore((s) => s.createGroup);
  const deleteGroup = useFoldersStore((s) => s.deleteGroup);
  const selectedFolderId = useFoldersStore((s) => s.selectedFolderId);
  const setSelectedFolder = useFoldersStore((s) => s.setSelectedFolder);

  const [addOpen, setAddOpen] = useState(false);
  const [manageFolder, setManageFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rename/alias modal state
  const [aliasFolder, setAliasFolder] = useState<Folder | null>(null);
  const [aliasValue, setAliasValue] = useState("");

  // Remove confirmation modal state
  const [removeFolderTarget, setRemoveFolderTarget] = useState<Folder | null>(null);

  // New group dialog state
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

  useEffect(() => {
    void loadFolders();
    void loadGroups();
  }, [loadFolders, loadGroups]);

  const handleOpenAlias = (folder: Folder) => {
    setAliasFolder(folder);
    setAliasValue(folder.alias ?? "");
  };

  const handleSaveAlias = async () => {
    if (!aliasFolder) return;
    try {
      const trimmed = aliasValue.trim();
      await updateFolder(aliasFolder.id, { alias: trimmed || null });
      setAliasFolder(null);
    } catch {
      setError("Failed to update alias");
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeFolderTarget) return;
    try {
      await removeFolder(removeFolderTarget.id);
      setRemoveFolderTarget(null);
    } catch {
      setError("Failed to remove folder");
    }
  };

  const handleCreateGroup = async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      setNewGroupOpen(false);
      return;
    }
    try {
      await createGroup(trimmed);
      setNewGroupName("");
      setNewGroupOpen(false);
    } catch {
      setError("Failed to create group");
    }
  };

  const grouped = groups
    .map((g) => ({ group: g, items: folders.filter((f) => f.groupId === g.id) }))
    .filter((g) => g.items.length > 0);
  const ungrouped = folders.filter((f) => !f.groupId);

  const renderFolder = (f: Folder) => {
    const label = f.alias || f.name;
    const isSelected = selectedFolderId === f.id;
    return (
      <div
        key={f.id}
        className="flex flex-col gap-2 rounded-lg border border-border p-3 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <FolderTile label={label} color={f.color} />
              <span className="text-sm font-medium">{label}</span>
              {f.alias && <span className="text-xs text-muted-foreground">({f.name})</span>}
              {isSelected && (
                <span className="text-2xs rounded-full bg-primary/10 px-2 py-0.5 text-primary font-medium">
                  Active
                </span>
              )}
            </div>
            <div className="font-mono text-xs text-muted-foreground">{f.path}</div>
          </div>
          <div className="shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Manage
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setManageFolder(f)}>
                  <Link2 className="size-4" />
                  {sidebarConfig.copy.manageLinks}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleOpenAlias(f)}>
                  <Pencil className="size-4" />
                  {sidebarConfig.copy.renameFolder}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette className="size-4" />
                    {sidebarConfig.copy.setColor}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[12rem] p-2">
                    <DropdownMenuItem
                      onSelect={() => void updateFolder(f.id, { color: DEFAULT_FOLDER_COLOR })}
                      className="gap-2"
                    >
                      <span
                        aria-hidden
                        className="size-4 shrink-0 rounded border border-border bg-[#6b7280]"
                      />
                      <span className="min-w-0 flex-1 truncate">Default</span>
                      {f.color === DEFAULT_FOLDER_COLOR && (
                        <span className="text-xs text-muted-foreground">✓</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <div className="grid grid-cols-6 gap-1">
                      {FOLDER_COLORS.map((color: string) => (
                        <button
                          key={color}
                          type="button"
                          title={color}
                          aria-label={color}
                          onClick={() => void updateFolder(f.id, { color })}
                          className="size-5 cursor-pointer rounded-sm outline-none ring-offset-1 ring-offset-popover transition-[box-shadow,transform] duration-100 hover:scale-110 data-[active]:ring-2 data-[active]:ring-foreground/60"
                          data-active={f.color === color ? "" : undefined}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setSelectedFolder(selectedFolderId === f.id ? null : f.id)}
                >
                  <FolderInput className="size-4" />
                  {selectedFolderId === f.id ? "Deselect" : "Select for navigation"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoveFolderTarget(f)}>
                  <Trash2 className="size-4" />
                  {sidebarConfig.copy.removeFromWorkspace}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  };

  return (
    <SettingsPage title="Folders" description="Manage folders registered as workspaces.">
      {error && <SettingsError>{error}</SettingsError>}

      <SettingsSection
        title="Registered folders"
        description="Folders available as workspaces for conversations."
        action={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <FolderPlus className="size-4" />
            Add folder
          </Button>
        }
      >
        {folders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No folders registered yet.</p>
        ) : (
          <div className="space-y-4">
            {grouped.map(({ group, items }) => (
              <div key={group.id} className="space-y-1">
                <div className="flex items-center justify-between px-1 py-0.5">
                  <span className="text-xs font-semibold text-muted-foreground">{group.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1"
                    onClick={() =>
                      void deleteGroup(group.id).catch(() => setError("Failed to delete group"))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                {items.map(renderFolder)}
              </div>
            ))}
            {ungrouped.map(renderFolder)}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Folder groups"
        description="Organize registered folders into named groups for the Folders list."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNewGroupName("");
              setNewGroupOpen(true);
            }}
          >
            <Layers className="size-4" />
            New group
          </Button>
          {groups.map((g) => (
            <span
              key={g.id}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
            >
              {g.name}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive cursor-pointer"
                onClick={() =>
                  void deleteGroup(g.id).catch(() => setError("Failed to delete group"))
                }
                aria-label={`Delete ${g.name}`}
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      </SettingsSection>

      {/* Rename Folder Dialog */}
      <Dialog open={!!aliasFolder} onOpenChange={(open) => !open && setAliasFolder(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{sidebarConfig.copy.renameFolderTitle}</DialogTitle>
            <DialogDescription>
              A display name shown in the sidebar. The folder on disk is not renamed. Leave blank to
              use the folder name.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={aliasValue}
            onChange={(e) => setAliasValue(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnter(e)) void handleSaveAlias();
            }}
            placeholder={aliasFolder?.name}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAliasFolder(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSaveAlias()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Folder Alert Dialog */}
      <AlertDialog
        open={!!removeFolderTarget}
        onOpenChange={(open) => !open && setRemoveFolderTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove folder?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{removeFolderTarget?.alias || removeFolderTarget?.name}&rdquo; will be removed
              from your workspace. Conversations attached to it will stay bound and can be accessed
              by re-opening the folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmRemove()}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New Group Dialog */}
      <Dialog open={newGroupOpen} onOpenChange={setNewGroupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder group</DialogTitle>
            <DialogDescription>
              Create a group name to organize your workspace folders.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (isPlainEnter(e)) void handleCreateGroup();
            }}
            placeholder="e.g. Work, Personal, OpenSource"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewGroupOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreateGroup()}>Create group</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorkspaceFolderDialog open={addOpen} onOpenChange={setAddOpen} />
      <WorkspaceFolderDialog
        open={!!manageFolder}
        onOpenChange={(o) => !o && setManageFolder(null)}
        folder={manageFolder}
      />
    </SettingsPage>
  );
}
