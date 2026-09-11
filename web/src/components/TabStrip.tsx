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
import { isTauri } from "../lib/platform";
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
 * Desktop tab strip built directly on the existing chatTabs Zustand store
 * (no second tab-state system). Reordering uses @dnd-kit/sortable and writes
 * back through the store's `reorder` action. Browser-only build: returns null.
 */
export function TabStrip() {
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

  if (!isTauri()) return null;

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

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-muted/40">
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
    </div>
  );
}
