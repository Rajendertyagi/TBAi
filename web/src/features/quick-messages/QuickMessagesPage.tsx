import { useEffect, useMemo, useRef, useState } from "react";
import {
  GripVertical,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { quickMessagesConfig } from "@/config/quick-messages";
import { useQuickMessagesStore } from "@/stores/quickMessagesStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { cn } from "@/lib/utils";

/**
 * Quick Messages settings surface (Codeg pixel parity, fixed split).
 * Fluid shell, one divided card (list + editor joined), grip-drag reorder
 * (HTML5 DnD — no motion dependency), dirty-gated save, delete confirm.
 * Copy + layout tokens come from `config/quick-messages.ts`. Drafts sync on
 * selection change only — never while dirty — so background reloads can't
 * discard unsent edits.
 */
export function QuickMessagesPage() {
  const copy = quickMessagesConfig.copy;
  const layout = quickMessagesConfig.layout;
  const messages = useQuickMessagesStore((s) => s.messages);
  const loading = useQuickMessagesStore((s) => s.loading);
  const error = useQuickMessagesStore((s) => s.error);
  const load = useQuickMessagesStore((s) => s.load);
  const create = useQuickMessagesStore((s) => s.create);
  const update = useQuickMessagesStore((s) => s.update);
  const remove = useQuickMessagesStore((s) => s.remove);
  const reorder = useQuickMessagesStore((s) => s.reorder);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [busy, setBusy] = useState<"create" | "save" | "delete" | "move" | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q),
    );
  }, [messages, search]);

  // Auto-select the first item only when nothing is selected yet.
  useEffect(() => {
    if (selectedId === null && messages.length > 0) {
      setSelectedId(messages[0].id);
    }
  }, [selectedId, messages]);

  const selected = messages.find((m) => m.id === selectedId) ?? null;

  // Sync drafts when the selection moves; never while dirty (a background
  // reload must not discard unsent edits).
  useEffect(() => {
    setDraftTitle(selected?.title ?? "");
    setDraftContent(selected?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const isDirty =
    selected != null &&
    (draftTitle !== selected.title || draftContent !== selected.content);

  const anyBusy = busy !== null;

  const handleCreate = async () => {
    if (anyBusy) return;
    setBusy("create");
    try {
      const result = await create();
      if (!result.ok || !result.message) {
        toast.error(copy.createFailed, { description: result.error });
        return;
      }
      setSelectedId(result.message.id);
      setSearch("");
      toast.success(copy.created);
      requestAnimationFrame(() => titleInputRef.current?.focus());
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (!selected || !isDirty || anyBusy) return;
    setBusy("save");
    try {
      const result = await update(selected.id, {
        title: draftTitle,
        content: draftContent,
      });
      if (result.ok) toast.success(copy.saved);
      else toast.error(copy.saveFailed, { description: result.error });
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteConfirm = async () => {
    const targetId = deleteTargetId;
    if (!targetId || anyBusy) return;
    setBusy("delete");
    try {
      const target = messages.find((m) => m.id === targetId);
      const result = await remove(targetId);
      if (result.ok) {
        toast.success(copy.deleted);
        setDeleteTargetId(null);
        if (selectedIdRef.current === targetId) {
          const remaining = messages.filter((m) => m.id !== targetId);
          setSelectedId(remaining[0]?.id ?? null);
        }
      } else {
        toast.error(copy.deleteFailed, {
          description:
            result.error ??
            copy.deleteDescription(target?.title || copy.untitled),
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const moveIds = (fromId: string, toIndex: number): string[] | null => {
    const ids = messages.map((m) => m.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return null;
    const [moved] = ids.splice(from, 1);
    if (moved === undefined) return null;
    const clamped = Math.max(0, Math.min(ids.length, toIndex));
    ids.splice(clamped, 0, moved);
    return ids;
  };

  const handleDropReorder = async (fromId: string, toIndex: number) => {
    if (anyBusy) return;
    const ids = moveIds(fromId, toIndex);
    if (!ids) return;
    setBusy("move");
    try {
      const result = await reorder(ids);
      if (!result.ok) toast.error(copy.saveOrderFailed, { description: result.error });
    } finally {
      setBusy(null);
      setDragId(null);
      setDropIndex(null);
    }
  };

  const deleteTargetMessage =
    deleteTargetId !== null
      ? (messages.find((m) => m.id === deleteTargetId) ?? null)
      : null;

  if (loading && messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
        {copy.loading}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-3 md:p-4">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div>
          <h2 className="text-base font-semibold">{copy.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{copy.description}</p>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1">
        <div className={cn(layout.splitClass, "h-full")}>
          {/* List pane */}
          <div className={cn(layout.listPaneClass)}>
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card lg:rounded-r-none">
              <div className="space-y-2.5 border-b border-border p-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={copy.searchPlaceholder}
                    aria-label={copy.searchPlaceholder}
                  />
                  <Button size="sm" onClick={() => void handleCreate()} disabled={anyBusy}>
                    {busy === "create" ? (
                      <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {copy.newAction}
                  </Button>
                </div>
              </div>

              {filtered.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
                  {messages.length === 0 ? copy.emptyList : copy.searchPlaceholder}
                </div>
              ) : (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {filtered.map((m) => {
                    const label = m.title || copy.untitled;
                    // Drop positions resolve in FULL-list coordinates (moves
                    // run there too), never filtered ones.
                    const fullIndex = messages.findIndex((x) => x.id === m.id);
                    return (
                      <div
                        key={m.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={selectedId === m.id}
                        aria-label={label}
                        draggable={!anyBusy}
                        onClick={() => setSelectedId(m.id)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          setSelectedId(m.id);
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", m.id);
                          event.dataTransfer.effectAllowed = "move";
                          setDragId(m.id);
                        }}
                        onDragOver={(event) => {
                          if (dragId === null || dragId === m.id) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDropIndex(fullIndex);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const fromId = event.dataTransfer.getData("text/plain");
                          if (fromId) void handleDropReorder(fromId, fullIndex);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setDropIndex(null);
                        }}
                        className={cn(
                          layout.rowClass,
                          selectedId === m.id && layout.rowSelectedClass,
                          dragId === m.id && "opacity-50",
                          dropIndex === fullIndex &&
                            dragId !== null &&
                            dragId !== m.id &&
                            "border-primary/60",
                        )}
                      >
                        <div className="flex items-center gap-2 overflow-hidden">
                          <button
                            type="button"
                            className={cn(
                              layout.gripClass,
                              "outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35",
                            )}
                            title={copy.dragSort}
                            aria-label={copy.dragSortMessage.replace("{name}", label)}
                            disabled={anyBusy}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <GripVertical aria-hidden="true" className="h-3.5 w-3.5" />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {m.title || (
                                <span className="italic text-muted-foreground">
                                  {copy.untitled}
                                </span>
                              )}
                            </div>
                            {m.content && (
                              <div className="mt-0.5 truncate text-[0.625rem] text-muted-foreground">
                                {m.content}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Editor pane */}
          <div className={cn(layout.editorPaneClass)}>
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card lg:rounded-l-none lg:border-l-0">
              {selected ? (
                <>
                  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                    <div className="space-y-1.5">
                      <label htmlFor="quick-message-title" className="text-xs font-medium">
                        {copy.titleLabel}
                      </label>
                      <Input
                        id="quick-message-title"
                        ref={titleInputRef}
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        placeholder={copy.titlePlaceholder}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="quick-message-content" className="text-xs font-medium">
                        {copy.contentLabel}
                      </label>
                      <Textarea
                        id="quick-message-content"
                        value={draftContent}
                        onChange={(event) => setDraftContent(event.target.value)}
                        placeholder={copy.contentPlaceholder}
                        className="min-h-65"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleteTargetId(selected.id)}
                      disabled={anyBusy}
                      className="text-red-500 hover:text-red-500"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                      {copy.deleteAction}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleSave()}
                      disabled={anyBusy || !isDirty}
                    >
                      {busy === "save" ? (
                        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                      ) : (
                        <Save aria-hidden="true" className="size-3.5" />
                      )}
                      {copy.saveAction}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {copy.emptySelection}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.deleteDescription(
                deleteTargetMessage?.title || copy.untitled,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>
              {copy.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDeleteConfirm();
              }}
              disabled={busy === "delete"}
            >
              {copy.confirmDelete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
