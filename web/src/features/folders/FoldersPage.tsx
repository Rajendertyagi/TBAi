import { useEffect, useState } from "react";
import { FolderPlus, Link2, Pencil, Palette, FolderInput, Trash2, Layers } from "lucide-react";
import { SettingsPage, SettingsSection, SettingRow, SettingsError } from "@/components/shared/settings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFoldersStore } from "@/stores/foldersStore";
import { WorkspaceFolderDialog } from "./WorkspaceFolderDialog";
import type { Folder } from "@/types";

/**
 * Folders settings surface (codeg-aligned). Register/manage project folders,
 * their linked/allowed paths, groups, alias and color. The globally-selected
 * folder here is UI navigation state only — it never becomes a chat's implicit
 * workspace; a conversation attaches to a folder explicitly (Project Chat).
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

  useEffect(() => {
    void loadFolders();
    void loadGroups();
  }, [loadFolders, loadGroups]);

  const grouped = groups
    .map((g) => ({ group: g, items: folders.filter((f) => f.groupId === g.id) }))
    .filter((g) => g.items.length > 0);
  const ungrouped = folders.filter((f) => !f.groupId);

  const renderFolder = (f: Folder) => {
    const label = f.alias || f.name;
    return (
      <SettingRow
        key={f.id}
        label={label}
        description={`${f.path}${f.conversationCount ? ` · ${f.conversationCount} chat(s)` : ""}`}
        control={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Manage
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setManageFolder(f)}>
                <Link2 className="size-4" />
                Linked folders
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  const alias = window.prompt("Set alias (blank to clear)", f.alias ?? "");
                  if (alias !== null)
                    void updateFolder(f.id, { alias: alias.trim() || null }).catch(() =>
                      setError("Failed to update alias"),
                    );
                }}
              >
                <Pencil className="size-4" />
                Set alias
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  const color = window.prompt("Set color (hex, e.g. #6b7280)", f.color);
                  if (color && color.trim())
                    void updateFolder(f.id, { color: color.trim() }).catch(() =>
                      setError("Failed to update color"),
                    );
                }}
              >
                <Palette className="size-4" />
                Set color
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setSelectedFolder(selectedFolderId === f.id ? null : f.id)}
              >
                <FolderInput className="size-4" />
                {selectedFolderId === f.id ? "Deselect" : "Select for navigation"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  if (window.confirm(`Remove "${label}" from registered folders?`))
                    void removeFolder(f.id).catch(() => setError("Failed to remove folder"));
                }}
              >
                <Trash2 className="size-4" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    );
  };

  return (
    <SettingsPage
      title="Folders"
      description="Register project folders. A Project Chat attaches to a folder by id; Simple Chat uses its own disposable workspace."
      actions={
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <FolderPlus aria-hidden="true" className="size-4" />
          Add folder
        </Button>
      }
    >
      {error && <SettingsError>{error}</SettingsError>}

      <SettingsSection
        title="Registered folders"
        description="Each folder is a workspace a Project Chat can target. Linked paths authorize additional directories."
      >
        {folders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No folders registered. Use “Add folder” to register a project directory.
          </p>
        ) : (
          <div className="space-y-3">
            {grouped.map(({ group, items }) => (
              <div key={group.id} className="space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Layers className="size-3.5" />
                  {group.name}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1"
                    onClick={() => void deleteGroup(group.id).catch(() => setError("Failed to delete group"))}
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
              const name = window.prompt("New group name");
              if (name && name.trim()) void createGroup(name.trim()).catch(() => setError("Failed to create group"));
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
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void deleteGroup(g.id).catch(() => setError("Failed to delete group"))}
                aria-label={`Delete ${g.name}`}
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      </SettingsSection>

      <WorkspaceFolderDialog open={addOpen} onOpenChange={setAddOpen} />
      <WorkspaceFolderDialog open={!!manageFolder} onOpenChange={(o) => !o && setManageFolder(null)} folder={manageFolder} />
    </SettingsPage>
  );
}
