/**
 * Single source of truth for the Quick Messages surface (user-saved reusable
 * composer snippets). Copy + layout tokens live here — components reference
 * these, never literals. Mirrors Codeg's QuickMessagesSettings key set.
 */
export interface QuickMessagesLayout {
  splitClass: string;
  listPaneClass: string;
  editorPaneClass: string;
  rowClass: string;
  rowSelectedClass: string;
  gripClass: string;
}

export interface QuickMessagesConfig {
  layout: QuickMessagesLayout;
  copy: {
    title: string;
    description: string;
    loading: string;
    loadFailed: string;
    emptyList: string;
    emptySelection: string;
    searchPlaceholder: string;
    untitled: string;
    dragSort: string;
    dragSortMessage: string;
    newAction: string;
    saveAction: string;
    deleteAction: string;
    moveUp: string;
    moveDown: string;
    titleLabel: string;
    titlePlaceholder: string;
    contentLabel: string;
    contentPlaceholder: string;
    deleteTitle: string;
    deleteDescription: (name: string) => string;
    cancel: string;
    confirmDelete: string;
    created: string;
    saved: string;
    deleted: string;
    createFailed: string;
    saveFailed: string;
    deleteFailed: string;
    saveOrderFailed: string;
  };
}

export const quickMessagesConfig: QuickMessagesConfig = {
  layout: {
    splitClass: "flex min-h-0 flex-1 flex-col gap-3 md:flex-row",
    listPaneClass: "flex min-h-0 w-full flex-col md:w-[34%]",
    editorPaneClass: "flex min-h-0 w-full flex-1 flex-col",
    rowClass:
      "rounded-lg border border-border bg-card p-2.5 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
    rowSelectedClass: "border-primary/60 bg-primary/5",
    gripClass:
      "text-muted-foreground cursor-grab active:cursor-grabbing rounded p-0.5 hover:bg-muted",
  },
  copy: {
    title: "Quick Messages",
    description: "Manage reusable message snippets. Drag to reorder.",
    loading: "Loading quick messages…",
    loadFailed: "Failed to load quick messages",
    emptyList: "No quick messages yet. Click “New” to create one.",
    emptySelection: "Select a quick message to edit.",
    searchPlaceholder: "Search by title or content",
    untitled: "Untitled",
    dragSort: "Drag to reorder",
    dragSortMessage: "Drag to reorder quick message: {name}",
    newAction: "New",
    saveAction: "Save",
    deleteAction: "Delete",
    moveUp: "Move up",
    moveDown: "Move down",
    titleLabel: "Title",
    titlePlaceholder: "Give this message a short title",
    contentLabel: "Content",
    contentPlaceholder: "Write the message content here",
    deleteTitle: "Delete quick message?",
    deleteDescription: (name: string) =>
      `This will permanently delete "${name}". Are you sure?`,
    cancel: "Cancel",
    confirmDelete: "Delete",
    created: "Quick message created",
    saved: "Quick message saved",
    deleted: "Quick message deleted",
    createFailed: "Failed to create quick message",
    saveFailed: "Failed to save quick message",
    deleteFailed: "Failed to delete quick message",
    saveOrderFailed: "Failed to save order",
  },
};
