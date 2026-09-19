import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { threadListAdapter } from "../app/adapter";
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
  const [title, setTitle] = useState<string>(() =>
    ref === "new" ? tabStripConfig.copy.newChat : tabStripConfig.copy.untitled,
  );

  useEffect(() => {
    if (ref === "new") {
      setTitle(tabStripConfig.copy.newChat);
      return;
    }
    let cancelled = false;
    threadListAdapter
      .fetch(ref)
      .then((meta) => {
        if (cancelled) return;
        setTitle((meta?.title as string | undefined) ?? tabStripConfig.copy.untitled);
      })
      .catch(() => {
        if (cancelled) return;
        setTitle(tabStripConfig.copy.untitled);
      });
    return () => {
      cancelled = true;
    };
  }, [ref]);

  return title;
}

/** Whether the thread behind this tab currently has a run in progress (fail-safe runtime readout). */
function useTabRunning(_ref: string): boolean {
  return false;
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
  const running = useTabRunning(tab.ref);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const setRefs = (el: HTMLDivElement | null) => {
    setNodeRef(el);
    nodeRef.current = el;
  };

  // Keep the active tab visible inside the overflow strip on switch.
  useEffect(() => {
    if (active) {
      nodeRef.current?.scrollIntoView({
        inline: "nearest",
        block: "nearest",
      });
    }
  }, [active]);

  return (
    <ContextMenuTrigger asChild>
      <div
        ref={setRefs}
        style={style}
        {...attributes}
        {...listeners}
        onClick={onSelect}
        onMouseDown={(e) => {
          // Middle-click closes (browser parity); the dnd-kit sensor only
          // activates on the primary button, so no drag conflict.
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        role="tab"
        aria-selected={active}
        title={title}
        data-active={active || undefined}
        className={cn(
          "min-w-0 grow-0 shrink basis-48 cursor-pointer select-none",
          active && "z-10",
          isDragging && "z-50",
        )}
      >
        <div
          className={cn(
            "group/tab relative flex h-full w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-t-lg px-2 text-xs transition-colors",
            active
              ? "bg-background text-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {running && (
            <span
              aria-label={tabStripConfig.copy.running}
              title={tabStripConfig.copy.running}
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
            />
          )}
          <span className="tab-title-fade min-w-0 flex-1 whitespace-nowrap">
            {title}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className={cn(
              "absolute right-1 top-0 bottom-0 my-auto flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-foreground/10",
              active
                ? "opacity-100"
                : "pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100",
            )}
            title={tabStripConfig.copy.closeTab}
            aria-label={tabStripConfig.copy.closeTab}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    </ContextMenuTrigger>
  );
}

/**
 * Single source of truth for the chat tab strip. Rendered once, in the content-
 * area title band of `AppShell` (codeg parity: equal-width browser tabs at the
 * top of the conversation column, not a full-width band). Each tab opens a
 * Radix right-click context menu (Close / Close Others / Close to the Right /
 * Copy Link / Close All) — DOM-based, so it is identical in the browser and
 * the Windows desktop.
 */
export function TabStrip() {
  const navigate = useNavigate();
  const tabs = useChatTabsStore((s) => s.tabs);
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const setActive = useChatTabsStore((s) => s.setActive);
  const close = useChatTabsStore((s) => s.close);
  const reorder = useChatTabsStore((s) => s.reorder);

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

  const closeAll = () => {
    // Composed from `close`: the store's never-zero-tabs rule leaves a fresh
    // draft behind, so the workbench always has a conversation to type in.
    const current = useChatTabsStore.getState().tabs;
    current.forEach((t) => close(t.key));
  };

  const copyLink = (tab: Tab) => {
    void navigator.clipboard?.writeText(urlForTab(tab));
  };

  return (
    <div
      role="tablist"
      aria-label="Chat tabs"
      className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto"
    >
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
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => copyLink(tab)}>
                  {tabStripConfig.copy.copyLink}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => closeAll()}>
                  {tabStripConfig.copy.closeAll}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={() => {
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
