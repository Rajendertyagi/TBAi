import { useEffect, useMemo, useRef, useState } from "react";
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
import { Plus, Unplug, X } from "lucide-react";
import { cn } from "../lib/utils";
import { tabStripConfig } from "../config/tabStrip";
import { usePreferencesStore } from "../features/preferences/state/preferencesStore";
import {
  NEW_DRAFT_TAB_ID,
  parseTabKey,
  type Tab,
  urlForTab,
  useChatTabsStore,
  visibleTabs,
} from "../features/chat/state/chatTabs";
import { evictIfGone, isConfirmedGone } from "../features/chat/state/tabReconciliation";

/**
 * Tab label, from the conversation row the server already returns.
 *
 * This probe is also the steady-state half of tab reconciliation: a
 * conversation deleted while the app is open is discovered HERE, on the request
 * this hook already made - no extra call, no new mechanism.
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
  detached,
  membershipFailure,
  onSelect,
  onClose,
}: {
  tab: Tab;
  index: number;
  active: boolean;
  detached: boolean;
  membershipFailure?: string;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { ref: sortableRef, isDragging } = useSortable({ id: tab.key, index });
  const title = useTabTitle(tab.ref);
  const running = useTabRunning(tab.ref);
  const nodeRef = useRef<HTMLDivElement | null>(null);

  const setRefs = (el: HTMLDivElement | null) => {
    sortableRef(el);
    nodeRef.current = el;
  };

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
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        role="tab"
        tabIndex={active ? 0 : -1}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSelect();
          }
        }}
        aria-selected={active}
        title={membershipFailure ? `${title} - ${membershipFailure}` : title}
        data-active={active || undefined}
        data-detached={detached || undefined}
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
          {detached ? (
            <Unplug
              className="size-3 shrink-0 opacity-60"
              aria-label="Detached from shared workspace"
            />
          ) : null}
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

export function TabStrip() {
  const navigate = useNavigate();
  const location = useLocation();
  const localActiveKey = useChatTabsStore((s) => s.localActiveKey);
  const hasLocalDraft = useChatTabsStore((s) => s.hasLocalDraft);
  const detachedRefs = useChatTabsStore((s) => s.detachedRefs);
  const membershipFailures = useChatTabsStore((s) => s.membershipFailures);
  const sharedTabs = usePreferencesStore((s) => s.snapshot?.sharedTabs);
  const tabs = useMemo(
    () =>
      visibleTabs({ localActiveKey, hasLocalDraft, detachedRefs, sharedTabs: sharedTabs ?? [] }),
    [localActiveKey, hasLocalDraft, detachedRefs, sharedTabs],
  );

  const onDragEnd = (event: DragEndEvent) => {
    if (event.canceled) return;
    const { source } = event.operation;
    if (!isSortable(source)) return;
    if (source.initialIndex === source.index) return;
    const tab = tabs[source.initialIndex];
    if (!tab || tab.ref === NEW_DRAFT_TAB_ID) return;
    // Convert visual index to shared-tabs index (draft tab is local-only, not in shared membership).
    const draftOffset = tabs[0]?.ref === NEW_DRAFT_TAB_ID ? 1 : 0;
    const toSharedIndex = Math.max(0, source.index - draftOffset);
    void useChatTabsStore.getState().requestSharedReorder(tab.ref, toSharedIndex);
  };

  const select = (tab: Tab) => {
    useChatTabsStore.getState().selectLocal(tab.key);
    const want = urlForTab(tab);
    if (location.pathname !== want) navigate(want);
  };

  const closeTab = (tab: Tab) => {
    if (tab.ref === NEW_DRAFT_TAB_ID) {
      useChatTabsStore.getState().closeLocal(tab.key);
      if (useChatTabsStore.getState().localActiveKey === undefined) {
        navigate(ROUTES.CHAT_NEW);
      }
      return;
    }
    void useChatTabsStore.getState().requestSharedClose(tab.ref);
  };

  const closeOthers = (tab: Tab) => {
    if (tab.ref === NEW_DRAFT_TAB_ID) return;
    void useChatTabsStore.getState().requestSharedCloseBatch({
      mode: "others",
      anchorConversationId: tab.ref,
    });
  };

  const closeToRight = (tab: Tab) => {
    if (tab.ref === NEW_DRAFT_TAB_ID) return;
    void useChatTabsStore.getState().requestSharedCloseBatch({
      mode: "right",
      anchorConversationId: tab.ref,
    });
  };

  const closeAll = () => {
    void useChatTabsStore.getState().requestSharedCloseBatch({ mode: "all" });
  };

  const copyLink = (tab: Tab) => {
    const fullUrl = `${window.location.origin}${window.location.pathname}#${urlForTab(tab)}`;
    void navigator.clipboard?.writeText(fullUrl);
  };

  return (
    <div
      role="tablist"
      aria-label="Chat tabs"
      className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto"
    >
      <DragDropProvider sensors={tabStripSensors} onDragEnd={onDragEnd}>
        {tabs.map((tab, index) => {
          const parsed = parseTabKey(tab.key);
          const ref = parsed?.ref;
          const detached = Boolean(
            ref && ref !== NEW_DRAFT_TAB_ID && (detachedRefs[ref] || tab.detached),
          );
          const failure = ref ? membershipFailures[ref]?.message : undefined;
          return (
            <ContextMenu key={tab.key}>
              <SortableTab
                tab={tab}
                index={index}
                active={tab.key === localActiveKey}
                detached={detached}
                membershipFailure={failure}
                onSelect={() => select(tab)}
                onClose={() => closeTab(tab)}
              />
              <ContextMenuContent className="min-w-44">
                {detached && ref && ref !== NEW_DRAFT_TAB_ID ? (
                  <>
                    <ContextMenuItem
                      onSelect={() =>
                        void useChatTabsStore.getState().requestSharedOpen(ref, tab.kind)
                      }
                    >
                      Open in shared workspace
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                ) : null}
                {failure && ref && ref !== NEW_DRAFT_TAB_ID ? (
                  <>
                    <ContextMenuItem
                      onSelect={() =>
                        void useChatTabsStore.getState().retrySharedOpen(ref, tab.kind)
                      }
                    >
                      Retry adding to shared workspace
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                  </>
                ) : null}
                <ContextMenuItem onSelect={() => closeTab(tab)}>
                  {tabStripConfig.copy.close}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeOthers(tab)}>
                  {tabStripConfig.copy.closeOthers}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeToRight(tab)}>
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
          );
        })}
      </DragDropProvider>
      <button
        type="button"
        onClick={() => {
          if (location.pathname !== ROUTES.CHAT_NEW) navigate(ROUTES.CHAT_NEW);
          useChatTabsStore.getState().openNewDraft();
        }}
        className="flex items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50"
        title={tabStripConfig.copy.newChat}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
    </div>
  );
}
