import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useFoldersStore } from "@/stores/foldersStore";
import { FolderHeader } from "./FolderHeader";
import { conversationIdFromPath } from "@/features/chat/state/chatTabs";import { FolderConversationRow } from "./FolderConversationRow";
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

  // Active conversation id from the URL — either engine surface (chat or
  // code). Scope UI keys off the conversation, never the engine route.
  const activeId = conversationIdFromPath(pathname);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  return (
    <>
      {folders.length === 0 ? null : (
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
