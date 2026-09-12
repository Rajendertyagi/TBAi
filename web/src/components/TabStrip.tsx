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
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
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

const menuItemClass =
  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted data-[disabled]:opacity-50";

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
            <ContextMenuPrimitive.Root key={tab.key}>
              <ContextMenuPrimitive.Trigger asChild>
                <SortableTab
                  tab={tab}
                  active={tab.key === activeKey}
                  onSelect={() => select(tab)}
                  onClose={() => close(tab.key)}
                />
              </ContextMenuPrimitive.Trigger>
              <ContextMenuPrimitive.Portal>
                <ContextMenuPrimitive.Content className="z-50 min-w-[170px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  <ContextMenuPrimitive.Item
                    className={menuItemClass}
                    onSelect={() => close(tab.key)}
                  >
                    Close
                  </ContextMenuPrimitive.Item>
                  <ContextMenuPrimitive.Item
                    className={menuItemClass}
                    onSelect={() => closeOthers(tab.key)}
                  >
                    Close Others
                  </ContextMenuPrimitive.Item>
                  <ContextMenuPrimitive.Item
                    className={menuItemClass}
                    onSelect={() => closeToRight(tab.key)}
                  >
                    Close to the Right
                  </ContextMenuPrimitive.Item>
                  <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
                  <ContextMenuPrimitive.Item
                    className={menuItemClass}
                    onSelect={() => copyLink(tab)}
                  >
                    Copy Link
                  </ContextMenuPrimitive.Item>
                </ContextMenuPrimitive.Content>
              </ContextMenuPrimitive.Portal>
            </ContextMenuPrimitive.Root>
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
