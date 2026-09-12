import { useNavigate } from "react-router";
import { useAuiState } from "@assistant-ui/react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { X, Plus } from "lucide-react";
import { cn } from "../lib/utils";
import {
  type Tab,
  urlForTab,
  useChatTabsStore,
} from "../features/chat/state/chatTabs";

function useTabTitle(ref: string): string {
  return useAuiState((s) => {
    if (ref === "new") return "New chat";
    const item = s.threads.threadItems.find((t) => t.remoteId === ref);
    return (item?.title as string | undefined) ?? "Untitled";
  });
}

function SortableTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tab.key });
  const title = useTabTitle(tab.ref);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onSelect}
      className={cn(
        "group flex max-w-[200px] cursor-pointer items-center gap-1.5 border-r border-border border-t-2 px-3 py-1.5 text-xs",
        active
          ? "border-t-primary bg-background text-foreground"
          : "border-t-transparent text-muted-foreground hover:bg-muted/50",
      )}
    >
      <span className="truncate">{title}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
        title="Close tab"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Single source of truth for the chat tab strip. Rendered exactly once per
 * surface (callers decide placement, so there is never a duplicate strip):
 * - `variant="band"`       → inside the Tauri top band (TopBand); fills the band
 *   and its trailing spacer is a window-drag region.
 * - `variant="standalone"` → inside the chat view (browser, which has no band);
 *   a self-contained bar with its own bottom border.
 * Keeps drag-to-reorder and shows every open tab kind (chat + settings).
 */
export function TabStrip({
  variant = "band",
}: {
  variant?: "band" | "standalone";
}) {
  const navigate = useNavigate();
  const tabs = useChatTabsStore((s) => s.tabs);
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const setActive = useChatTabsStore((s) => s.setActive);
  const close = useChatTabsStore((s) => s.close);
  const reorder = useChatTabsStore((s) => s.reorder);
  const openChat = useChatTabsStore((s) => s.openChat);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = tabs.findIndex((t) => t.key === active.id);
    const to = tabs.findIndex((t) => t.key === over.id);
    if (from !== -1 && to !== -1) reorder(from, to);
  };

  const select = (tab: Tab) => {
    setActive(tab.key);
    navigate(urlForTab(tab));
  };

  const containerClass =
    variant === "band"
      ? "flex h-full min-w-0 flex-1 items-stretch overflow-x-auto"
      : "flex shrink-0 items-stretch gap-0 overflow-x-auto border-b border-border bg-muted/40 px-2";

  return (
    <div className={containerClass}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tabs.map((t) => t.key)} strategy={horizontalListSortingStrategy}>
          {tabs.map((tab) => (
            <SortableTab
              key={tab.key}
              tab={tab}
              active={tab.key === activeKey}
              onSelect={() => select(tab)}
              onClose={() => close(tab.key)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={() => {
          openChat("new");
          navigate("/chat/new");
        }}
        className="flex items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50"
        title="New chat"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {variant === "band" ? (
        <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
      ) : (
        <div className="h-full min-w-10 flex-1" />
      )}
    </div>
  );
}
