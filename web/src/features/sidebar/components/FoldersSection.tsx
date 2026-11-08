import { useState } from "react";
import { useLocation } from "react-router";
import {
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
  type DragEndEvent,
  type Sensors,
} from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useFoldersStore } from "@/features/folders/state/foldersStore";
import { FolderHeader } from "./FolderHeader";
import { conversationIdFromPath } from "@/features/chat/state/chatTabs";
import { FolderConversationRow } from "./FolderConversationRow";
import { WorkspaceFolderDialog } from "@/features/folders/WorkspaceFolderDialog";
import { cn } from "@/lib/utils";
import type { Folder } from "@/types";

/**
 * Sensor configuration for folder dragging.
 * Minimum 5px pointer movement prevents accidental drag when simply clicking to expand.
 */
const folderDragSensors = (defaults: Sensors): Sensors => [
  ...defaults.filter((sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor),
  PointerSensor.configure({
    activationConstraints: [
      new PointerActivationConstraints.Distance({
        value: 5,
      }),
    ],
  }),
  KeyboardSensor.configure({}),
];

function SortableFolderBlock({
  folder,
  index,
  expanded,
  activeId,
  onToggle,
  onManageLinks,
  onOpenThread,
}: {
  folder: Folder;
  index: number;
  expanded: boolean;
  activeId: string | null;
  onToggle: (id: string) => void;
  onManageLinks: (folder: Folder) => void;
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const { ref: sortableRef, isDragging } = useSortable({ id: folder.id, index });

  return (
    <div
      ref={sortableRef}
      className={cn(
        "sidebar-folder-block flex flex-col transition-opacity",
        isDragging && "opacity-50",
      )}
    >
      <FolderHeader
        folder={folder}
        expanded={expanded}
        onToggle={onToggle}
        onManageLinks={onManageLinks}
      />
      {expanded && (
        <div className="sidebar-folder-children flex flex-col gap-0.5">
          <FolderConversationRow folder={folder} activeId={activeId} onOpenThread={onOpenThread} />
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible "Folders" section in the sidebar with drag-and-drop reordering.
 * Reordering persists across reloads via foldersStore.reorderFolders.
 */
export function FoldersSection({
  onOpenThread,
}: {
  onOpenThread: (remoteId: string, engine?: string | null) => void;
}) {
  const folders = useFoldersStore((s) => s.folders);
  const folderExpanded = useFoldersStore((s) => s.folderExpanded);
  const setFolderExpanded = useFoldersStore((s) => s.setFolderExpanded);
  const reorderFolders = useFoldersStore((s) => s.reorderFolders);
  const [manageLinksFolder, setManageLinksFolder] = useState<Folder | null>(null);
  const { pathname } = useLocation();

  const activeId = conversationIdFromPath(pathname);

  const onDragEnd = (event: DragEndEvent) => {
    if (event.canceled) return;
    const { operation } = event;
    const { source, target } = operation;
    if (!source || !target || source.id === target.id) return;
    if (!isSortable(source) || !isSortable(target)) return;

    const fromIndex = source.index;
    const toIndex = target.index;
    if (fromIndex === toIndex) return;

    const reordered = [...folders];
    const [moved] = reordered.splice(fromIndex, 1);
    if (!moved) return;
    reordered.splice(toIndex, 0, moved);

    void reorderFolders(reordered.map((f) => f.id));
  };

  return (
    <>
      {folders.length === 0 ? null : (
        <DragDropProvider sensors={folderDragSensors} onDragEnd={onDragEnd}>
          {folders.map((folder, index) => {
            const expanded = folderExpanded[folder.id] ?? true;
            return (
              <SortableFolderBlock
                key={folder.id}
                folder={folder}
                index={index}
                expanded={expanded}
                activeId={activeId}
                onToggle={(id) => setFolderExpanded(id, !expanded)}
                onManageLinks={setManageLinksFolder}
                onOpenThread={onOpenThread}
              />
            );
          })}
        </DragDropProvider>
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
