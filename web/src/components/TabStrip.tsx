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
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";
import { X, Plus } from "lucide-react";
import { cn } from "../lib/utils";
import { tabStripConfig } from "../config/tabStrip";
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
    <ContextMenuTrigger asChild>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        onClick={onSelect}
        className={cn(
          "group flex max-w-50 cursor-pointer items-center gap-1.5 border-r border-border border-t-2 px-3 py-1.5 text-xs",
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
          title={tabStripConfig.copy.closeTab}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </ContextMenuTrigger>
  );
}

/**
 * Single source of truth for the chat tab strip. Rendered once, in the content-
 * area `h-10` strip of `AppShell` (codeg parity: tabs live at the top of the
 * conversation column, not a full-width band). Each tab opens a Radix right-click
 * context menu (Close / Close Others / Close to the Right / Copy Link) — DOM-
 * based, so it is identical in the browser and the Tauri desktop.
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

  const closeOthers = (key: string) => {
    const current = useChatTabsStore.getState().tabs;
    current.filter((t) => t.key !== key).forEach((t) => close(t.key));
  };

  const closeToRight = (key: string) => {
    const current = useChatTabsStore.getState().tabs;
    const idx = current.findIndex((t) => t.key === key);
    current.slice(idx + 1).forEach((t) => close(t.key));
  };

  const copyLink = (tab: Tab) => {
    void navigator.clipboard?.writeText(urlForTab(tab));
  };

  return (
    <div className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={tabs.map((t) => t.key)}
          strategy={horizontalListSortingStrategy}
        >
          {tabs.map((tab) => (
            <ContextMenu key={tab.key}>
              <SortableTab
                tab={tab}
                active={tab.key === activeKey}
                onSelect={() => select(tab)}
                onClose={() => close(tab.key)}
              />
              <ContextMenuContent className="min-w-44">
                <ContextMenuItem onSelect={() => close(tab.key)}>
                  {tabStripConfig.copy.close}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeOthers(tab.key)}>
                  {tabStripConfig.copy.closeOthers}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeToRight(tab.key)}>
                  {tabStripConfig.copy.closeToRight}
                </ContextMenuItem>
                <ContextMenuSeparator className="my-1 h-px bg-border" />
                <ContextMenuItem onSelect={() => copyLink(tab)}>
                  {tabStripConfig.copy.copyLink}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
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
        title={tabStripConfig.copy.newChat}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {/* Guaranteed window-drag region to the right of the new-chat button: even
          when many tabs overflow and squeeze the row, a grabbable gap always
          remains so the strip stays draggable (mirrors codeg's tab-strip tail). */}
      <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
    </div>
  );
}
