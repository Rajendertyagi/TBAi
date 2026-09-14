import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { FolderPlus } from "lucide-react";
import { useFoldersStore } from "@/stores/foldersStore";
import { FolderHeader } from "./FolderHeader";
import { FolderConversationRow } from "./FolderConversationRow";
import { WorkspaceFolderDialog } from "@/features/folders/WorkspaceFolderDialog";
import type { Folder } from "@/types";

/**
 * Collapsible "Folders" section in the sidebar (codeg parity). Renders
 * registered project folders as expandable headers; project conversations
 * appear under their folder. Hidden chat folders are excluded by the API.
 *
 * The "Open Folder" action lives on the Folders section header (passed via
 * Sidebar's `actions` prop), not inside this component.
 */
export function FoldersSection() {
  const folders = useFoldersStore((s) => s.folders);
  const folderExpanded = useFoldersStore((s) => s.folderExpanded);
  const setFolderExpanded = useFoldersStore((s) => s.setFolderExpanded);
  const loadFolders = useFoldersStore((s) => s.loadFolders);
  const [manageLinksFolder, setManageLinksFolder] = useState<Folder | null>(
    null,
  );
  const { pathname } = useLocation();

  // Extract the active conversation id from the URL (/chat/:threadId).
  const activeId = pathname.startsWith("/chat/")
    ? pathname.slice(6) || null
    : null;

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  return (
    <>
      {folders.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
          <FolderPlus className="size-5 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            No folders registered.
          </p>
          <p className="text-xs text-muted-foreground">
            Hover the &ldquo;Folders&rdquo; header and click the folder icon to
            add one.
          </p>
        </div>
      ) : (
        folders.map((folder) => {
          const expanded = folderExpanded[folder.id] ?? true;
          return (
            <div key={folder.id} className="flex flex-col">
              <FolderHeader
                folder={folder}
                expanded={expanded}
                onToggle={(id) => setFolderExpanded(id, !expanded)}
                onManageLinks={setManageLinksFolder}
              />
              {expanded && (
                <FolderConversationRow
                  folderId={folder.id}
                  activeId={activeId}
                />
              )}
            </div>
          );
        })
      )}

      <WorkspaceFolderDialog
        open={!!manageLinksFolder}
        onOpenChange={(o) => {
          if (!o) setManageLinksFolder(null);
        }}
        folder={manageLinksFolder}
      />
    </>
  );
}
