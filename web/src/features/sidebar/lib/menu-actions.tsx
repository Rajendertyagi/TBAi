import type { ComponentType, ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  FolderOpen,
  Link2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { sidebarConfig } from "@/config/sidebar";

/**
 * The one action list behind a sidebar row's `⋯` button and its right-click.
 *
 * Both entry points render these descriptors through the same function, so a
 * menu item added or reordered here appears in both — there is no second list
 * that can drift. Two Radix primitives are involved (DropdownMenu for the
 * button, ContextMenu for the right-click); they share an item prop shape, and
 * `SidebarMenuKit` carries whichever pair is in use.
 */
export interface SidebarMenuItemProps {
  className?: string;
  variant?: "default" | "destructive";
  onSelect?: (event: Event) => void;
  children?: ReactNode;
}

export type SidebarMenuItemComponent = ComponentType<SidebarMenuItemProps>;
export type SidebarMenuPartComponent = ComponentType<{ children?: ReactNode }>;
export type SidebarMenuSubContentComponent = ComponentType<{
  className?: string;
  children?: ReactNode;
}>;

/** The primitives a menu body renders into: dropdown or context flavour. */
export interface SidebarMenuKit {
  Item: SidebarMenuItemComponent;
  Separator: ComponentType;
  Sub: SidebarMenuPartComponent;
  SubTrigger: SidebarMenuPartComponent;
  SubContent: SidebarMenuSubContentComponent;
}

export interface SidebarMenuAction {
  key: string;
  label: string;
  icon: ReactNode;
  destructive?: boolean;
  /** Consecutive actions in different groups are separated by a rule. */
  group: number;
  onSelect: () => void;
}

/**
 * A folder menu entry. "color" is the one item that opens a second level, and
 * its body needs the submenu primitives, so it stays a distinct kind.
 */
export type FolderMenuEntry =
  | { kind: "action"; action: SidebarMenuAction }
  | {
      kind: "color";
      key: string;
      label: string;
      group: number;
      current: string;
      onPick: (color: string) => void;
    };

export interface ThreadRowMenuInput {
  archived: boolean;
  renameEnabled: boolean;
  archiveEnabled: boolean;
  deleteEnabled: boolean;
  onOpen: () => void;
  onOpenInExplorer?: () => void;
  /** Required only when `renameEnabled` is true. */
  onRename?: () => void;
  onToggleArchive: () => void;
  onCopyId: () => void;
  onCopyUrl?: () => void;
  onDelete: () => void;
}

/**
 * Chat row menu: open it, name it, copy or archive it — then delete it.
 *
 * `Delete…` opens a confirmation dialog; the ellipsis is the promise that a
 * follow-up step exists, and the row wires one.
 */
export function buildThreadRowActions(input: ThreadRowMenuInput): SidebarMenuAction[] {
  const copy = sidebarConfig.copy;
  const actions: SidebarMenuAction[] = [
    {
      key: "open",
      label: copy.openInNewTab,
      icon: <ExternalLink className="size-4" />,
      group: 0,
      onSelect: input.onOpen,
    },
  ];

  if (input.renameEnabled && input.onRename) {
    const onRename = input.onRename;
    actions.push({
      key: "rename",
      label: copy.rename,
      icon: <Pencil className="size-4" />,
      group: 0,
      onSelect: onRename,
    });
  }

  if (input.onOpenInExplorer) {
    actions.push({
      key: "open-explorer",
      label: copy.openInExplorer,
      icon: <FolderOpen className="size-4" />,
      group: 0,
      onSelect: input.onOpenInExplorer,
    });
  }

  actions.push({
    key: "copy-id",
    label: copy.copyId,
    icon: <Copy className="size-4" />,
    group: 1,
    onSelect: input.onCopyId,
  });

  if (input.onCopyUrl) {
    actions.push({
      key: "copy-url",
      label: copy.copyUrl,
      icon: <Link2 className="size-4" />,
      group: 1,
      onSelect: input.onCopyUrl,
    });
  }

  if (input.archiveEnabled) {
    actions.push({
      key: "archive",
      label: input.archived ? copy.unarchive : copy.archive,
      icon: input.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
      group: 1,
      onSelect: input.onToggleArchive,
    });
  }

  if (input.deleteEnabled) {
    actions.push({
      key: "delete",
      label: copy.deleteMenuItem,
      icon: <Trash2 className="size-4" />,
      destructive: true,
      group: 2,
      onSelect: input.onDelete,
    });
  }

  return actions;
}

export interface FolderMenuInput {
  color: string;
  /**
   * Platforms without a desktop shell cannot open a file manager. The item is
   * omitted rather than shown disabled: a menu entry that cannot act is a
   * promise the app cannot keep.
   */
  canOpenInExplorer: boolean;
  onNewChat: () => void;
  onRename: () => void;
  onPickColor: (color: string) => void;
  onManageLinks: () => void;
  onOpenInExplorer: () => void;
  onCopyPath: () => void;
  onRemove: () => void;
}

/**
 * Folder row menu: the four in-app actions, then the two that reach outside
 * the app (Explorer, copy path), then removal.
 */
export function buildFolderMenuEntries(input: FolderMenuInput): FolderMenuEntry[] {
  const copy = sidebarConfig.copy;
  const entries: FolderMenuEntry[] = [
    {
      kind: "action",
      action: {
        key: "new-chat",
        label: copy.newChatInFolder,
        icon: <Plus className="size-4" />,
        group: 0,
        onSelect: input.onNewChat,
      },
    },
    {
      kind: "action",
      action: {
        key: "rename",
        label: copy.renameFolder,
        icon: <Pencil className="size-4" />,
        group: 0,
        onSelect: input.onRename,
      },
    },
    {
      kind: "color",
      key: "color",
      label: copy.setColor,
      group: 0,
      current: input.color,
      onPick: input.onPickColor,
    },
    {
      kind: "action",
      action: {
        key: "manage-links",
        label: copy.manageLinks,
        icon: <Link2 className="size-4" />,
        group: 0,
        onSelect: input.onManageLinks,
      },
    },
  ];

  if (input.canOpenInExplorer) {
    entries.push({
      kind: "action",
      action: {
        key: "open-explorer",
        label: copy.openInExplorer,
        icon: <FolderOpen className="size-4" />,
        group: 1,
        onSelect: input.onOpenInExplorer,
      },
    });
  }

  entries.push({
    kind: "action",
    action: {
      key: "copy-path",
      label: copy.copyFolderPath,
      icon: <Copy className="size-4" />,
      group: 1,
      onSelect: input.onCopyPath,
    },
  });

  entries.push({
    kind: "action",
    action: {
      key: "remove",
      label: copy.removeFromWorkspace,
      icon: <Trash2 className="size-4" />,
      destructive: true,
      group: 2,
      onSelect: input.onRemove,
    },
  });

  return entries;
}
