import { create } from "zustand";
import { NEW_DRAFT_TAB_ID, parseTabKey } from "../../chat/state/chatTabs";

/**
 * Workspace panel arrangement (device-local UI state only).
 *
 * A panel is a generic container identified by a stable id. Its `tabKey` is a
 * chat tab key (`chat:<ref>` / `agent:<ref>`) from the canonical chatTabs store —
 * this store never duplicates conversation identity or message state.
 *
 * `order` is the visual position. Content hosts are rendered as stable, keyed
 * siblings under one parent; moving a panel changes `order` only, so React
 * never reparents or remounts the runtime-bearing host.
 */
export interface WorkspacePanel {
  id: string;
  tabKey: string;
  order: number;
}

interface WorkspacePanelsState {
  panels: WorkspacePanel[];
  /** Add a panel for a tab key if not already present. */
  openPanel: (tabKey: string) => void;
  /** Remove a panel by id (disposes only that content's runtime on unmount). */
  closePanel: (id: string) => void;
  /** Move a panel to a new visual position (order only — no remount). */
  movePanel: (id: string, toIndex: number) => void;
}

let panelSeq = 0;
const nextId = () => `panel-${++panelSeq}`;

export const useWorkspacePanels = create<WorkspacePanelsState>((set) => ({
  panels: [],
  openPanel: (tabKey) =>
    set((state) => {
      // Only bound Direct chat tabs can be paneled. Drafts need the primary
      // runtime's tab-store binding; OpenCode keeps its own surface. Rejecting
      // here keeps the store free of entries the surface can never render.
      const parsed = parseTabKey(tabKey);
      if (parsed?.kind !== "chat" || parsed.ref === NEW_DRAFT_TAB_ID) return state;
      if (state.panels.some((p) => p.tabKey === tabKey)) return state;
      const order = state.panels.length;
      return { panels: [...state.panels, { id: nextId(), tabKey, order }] };
    }),
  closePanel: (id) => set((state) => ({ panels: state.panels.filter((p) => p.id !== id) })),
  movePanel: (id, toIndex) =>
    set((state) => {
      const sorted = [...state.panels].sort((a, b) => a.order - b.order);
      const from = sorted.findIndex((p) => p.id === id);
      if (from < 0 || toIndex < 0 || toIndex >= sorted.length) return state;
      const [moved] = sorted.splice(from, 1);
      sorted.splice(toIndex, 0, moved);
      // Reassign contiguous order values; host identity (id) is unchanged.
      const orderById = new Map(sorted.map((p, i) => [p.id, i]));
      return {
        panels: state.panels.map((p) => ({ ...p, order: orderById.get(p.id) ?? p.order })),
      };
    }),
}));
