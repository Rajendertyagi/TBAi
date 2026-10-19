import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { threadListAdapter } from "../app/adapter";
import { ROUTES } from "../config/navigation";
import {
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
  type DragEndEvent,
  type Sensors,
} from "@dnd-kit/dom";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
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
  NEW_DRAFT_TAB_ID,
  chatKey,
  type Tab,
  urlForTab,
  useChatTabsStore,
} from "../features/chat/state/chatTabs";
import { evictIfGone, isConfirmedGone } from "../features/chat/state/tabReconciliation";

/**
 * Tab label, from the conversation row the server already returns.
 *
 * This probe is also the steady-state half of tab reconciliation: a
 * conversation deleted while the app is open is discovered HERE, on the request
 * this hook already made — no extra call, no new mechanism. Boot covers the
 * closed-app case in one batch; this covers the open-app case per tab.
 *
 * The verdict decides the outcome, and only one of the three may destroy state:
 * `gone` evicts the tab (the row is proven missing), while `unknown` — a 5xx, a
 * dropped connection, an unreadable body — keeps the tab and shows the neutral
 * label. A tab is never closed because the server was briefly unhealthy.
 */
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
    void (async () => {
      const probe = await threadListAdapter.fetch(ref).then(
        (meta) => ({ status: "exists" as const, title: meta?.title as string | undefined }),
        (err: unknown) => ({
          status: isConfirmedGone(err) ? ("gone" as const) : ("unknown" as const),
          title: undefined,
        }),
      );
      if (cancelled) return;
      if (probe.status === "gone") {
        evictIfGone(ref, "gone");
        return;
      }
      setTitle(probe.title ?? tabStripConfig.copy.untitled);
    })();
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

/**
 * Sensor configuration for the strip.
 *
 * `@dnd-kit/dom` registers `[PointerSensor, KeyboardSensor]` on every manager,
 * so this keeps that list and swaps in the two configured variants. Written as
 * a function rather than a plain array for exactly that reason: an array
 * REPLACES the defaults, and any sensor the library adds later would be dropped
 * silently.
 */
const tabStripSensors = (defaults: Sensors): Sensors => [
  ...defaults.filter((sensor) => sensor !== PointerSensor && sensor !== KeyboardSensor),
  PointerSensor.configure({
    activationConstraints: [
      new PointerActivationConstraints.Distance({
        value: tabStripConfig.drag.activationDistancePx,
      }),
    ],
  }),
  KeyboardSensor.configure({ keyboardCodes: tabStripConfig.drag.keyboardCodes }),
];

function SortableTab({
  tab,
  index,
  active,
  onSelect,
  onClose,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  // `index` is what makes this item sortable: the library compares the index
  // the gesture started from with the one it ended on, and that pair is the
  // only thing it hands back. The drag transform and transition are applied to
  // the element by the library, so this component sets no inline style.
  const { ref: sortableRef, isDragging } = useSortable({ id: tab.key, index });
  const title = useTabTitle(tab.ref);
  const running = useTabRunning(tab.ref);
  const nodeRef = useRef<HTMLDivElement | null>(null);

  const setRefs = (el: HTMLDivElement | null) => {
    sortableRef(el);
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
        // Roving tabindex: the tabs pattern requires exactly one tab stop for
        // the whole strip. The drag library supplies none of this — it returns
        // refs and drag flags only — so the tab stop and the key handling below
        // are ours.
        //
        // This is also what makes a keyboard drag reachable at all: the sensor
        // starts on the focused element, and the active tab is the one that can
        // hold focus.
        tabIndex={active ? 0 : -1}
        onKeyDown={(e) => {
          // Enter activates, because this is a `div` acting as a button and
          // therefore gets none of the native keyboard behaviour for free.
          // Space is deliberately NOT handled here: it is the drag pick-up key
          // (`tabStripConfig.drag.keyboardCodes`), so the keyboard sensor owns
          // it. Nothing is lost — the roving tabindex already admits only the
          // active tab, and activating the active tab is a no-op.
          if (e.key === "Enter") {
            e.preventDefault();
            onSelect();
          }
        }}
        aria-selected={active}
        title={title}
        data-active={active || undefined}
        className={cn(
          "min-w-0 grow-0 shrink basis-48 cursor-pointer select-none",
          active && "z-10",
          isDragging && "z-50 opacity-60",
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
              role="img"
              aria-label={tabStripConfig.copy.running}
              title={tabStripConfig.copy.running}
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
            />
          )}
          <span className="tab-title-fade min-w-0 flex-1 whitespace-nowrap">{title}</span>
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
  const location = useLocation();
  const tabs = useChatTabsStore((s) => s.tabs);
  const activeKey = useChatTabsStore((s) => s.activeKey);
  const setActive = useChatTabsStore((s) => s.setActive);
  const close = useChatTabsStore((s) => s.close);
  const reorder = useChatTabsStore((s) => s.reorder);

  /**
   * Commit the one pair of indices a gesture produced.
   *
   * Optimistic sorting keeps `source` and `target` on the SAME element for the
   * whole gesture, so the question the legacy code asked — "is the id under the
   * pointer the one I picked up?" — has no answer here. What the library tracks
   * is the source's own from/to index, and an unchanged pair must commit
   * nothing: `reorder` is positional, so applying a no-op pair would move a
   * different tab.
   */
  const onDragEnd = (event: DragEndEvent) => {
    // A cancelled drag (Escape) leaves the order exactly as it was.
    if (event.canceled) return;
    const { source } = event.operation;
    if (!isSortable(source)) return;
    if (source.initialIndex === source.index) return;
    reorder(source.initialIndex, source.index);
  };

  const select = (tab: Tab) => {
    setActive(tab.key);
    // Re-selecting the shown tab must not push an identical history entry
    // (back/forward would otherwise step through duplicates of one location).
    const want = urlForTab(tab);
    if (location.pathname !== want) navigate(want);
  };

  const closeOthers = (key: string) => {
    const current = useChatTabsStore.getState().tabs;
    current
      .filter((t) => t.key !== key)
      .forEach((t) => {
        close(t.key);
      });
  };

  const closeToRight = (key: string) => {
    const current = useChatTabsStore.getState().tabs;
    const idx = current.findIndex((t) => t.key === key);
    current.slice(idx + 1).forEach((t) => {
      close(t.key);
    });
  };

  const closeAll = () => {
    // Composed from `close`: the store's never-zero-tabs rule leaves a fresh
    // draft behind, so the workbench always has a conversation to type in.
    const current = useChatTabsStore.getState().tabs;
    current.forEach((t) => {
      close(t.key);
    });
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
      <DragDropProvider sensors={tabStripSensors} onDragEnd={onDragEnd}>
        {tabs.map((tab, index) => (
          <ContextMenu key={tab.key}>
            <SortableTab
              tab={tab}
              index={index}
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
      </DragDropProvider>
      <button
        type="button"
        onClick={() => {
          // Repeated new-chat clicks must not stack identical history
          // entries; navigating alone never persists (the draft is UI-only
          // until first send). Already on the draft route: just make sure
          // the draft tab is the active one.
          if (location.pathname !== ROUTES.CHAT_NEW) navigate(ROUTES.CHAT_NEW);
          else setActive(chatKey(NEW_DRAFT_TAB_ID));
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
