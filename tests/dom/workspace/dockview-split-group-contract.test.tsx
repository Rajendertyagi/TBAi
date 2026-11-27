/**
 * DOM-level split/group contract for the restored Dockview layout.
 *
 * A pointer-driven real Dockview split needs a layout engine and is covered by
 * tests/e2e/workspace/dockview-workspace.spec.ts. This DOM test covers the
 * persistence half of that contract: a saved two-group branch must restore as
 * two distinct groups with two distinct canonical panels, and a panel's
 * identity/params must be independent of which group it sits in. It would fail
 * if persistence dropped a group, rewrote a panel id, or stored non-identity
 * data in params.
 */
import { describe, it, expect } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  loadLayout,
  saveLayout,
  type LayoutStorage,
} from "@web/features/workspace/state/layoutPersistence";

type SerializedDockview = Parameters<typeof saveLayout>[0];
type Grid = SerializedDockview["grid"]["root"];

function fakeStorage(): LayoutStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function twoGroupLayout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { id: "group-a", views: ["chat:a"], activeView: "chat:a" },
            size: 50,
          },
          {
            type: "leaf",
            data: { id: "group-b", views: ["chat:b"], activeView: "chat:b" },
            size: 50,
          },
        ],
        size: 100,
      },
      height: 100,
      width: 100,
      orientation: "HORIZONTAL" as SerializedDockview["grid"]["orientation"],
    },
    panels: {
      "chat:a": {
        id: "chat:a",
        contentComponent: "tbai-direct",
        params: { tabKey: "chat:a", contentType: "direct" },
      },
      "chat:b": {
        id: "chat:b",
        contentComponent: "tbai-direct",
        params: { tabKey: "chat:b", contentType: "direct" },
      },
    },
    activeGroup: "group-a",
  };
}

interface GroupLeaf {
  id: string;
  views: string[];
}

function groupLeaves(layout: SerializedDockview): GroupLeaf[] {
  const root = layout.grid.root as Grid & { data: unknown };
  if (root.type !== "branch") return [];
  return (root.data as Array<{ data: { id: string; views: string[] } }>).map((leaf) => ({
    id: leaf.data.id,
    views: leaf.data.views,
  }));
}

function RestoredLayout({ layout }: { layout: SerializedDockview }) {
  return (
    <div data-testid="restored-layout">
      {groupLeaves(layout).map((group) => (
        <div key={group.id} data-testid="group" data-group-id={group.id}>
          {group.views.map((id) => {
            const panel = layout.panels[id]!;
            return (
              <div
                key={id}
                data-testid="panel"
                data-panel-id={panel.id}
                data-content-type={panel.params.contentType}
                data-param-keys={Object.keys(panel.params).sort().join(",")}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function renderLayout(layout: SerializedDockview): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RestoredLayout layout={layout} />);
  });
  return { container, root };
}

function cleanup(container: HTMLElement, root: Root): void {
  act(() => root.unmount());
  container.remove();
}

describe("Dockview split/group contract — restored layout", () => {
  it("restores a two-group branch as two distinct groups with canonical panels", () => {
    const storage = fakeStorage();
    saveLayout(twoGroupLayout(), undefined, storage);
    const restored = loadLayout(undefined, ["chat:a", "chat:b"], storage);
    expect(restored).not.toBeNull();

    const { container, root } = renderLayout(restored!);
    try {
      const groups = [...container.querySelectorAll<HTMLElement>('[data-testid="group"]')];
      expect(groups.length).toBe(2);
      const groupIds = groups.map((g) => g.getAttribute("data-group-id"));
      expect(new Set(groupIds).size).toBe(2);

      const panels = [...container.querySelectorAll<HTMLElement>('[data-testid="panel"]')];
      expect(panels.length).toBe(2);
      expect(panels.map((p) => p.getAttribute("data-panel-id")).sort()).toEqual([
        "chat:a",
        "chat:b",
      ]);
      for (const panel of panels) {
        expect(panel.getAttribute("data-content-type")).toBe("direct");
        // Identity-only params: no message text, drafts, credentials or paths.
        expect(panel.getAttribute("data-param-keys")).toBe("contentType,tabKey");
      }
    } finally {
      cleanup(container, root);
    }
  });

  it("keeps panel identity and params independent of group placement", () => {
    const layout = twoGroupLayout();
    // Simulate a split-then-move: chat:a leaves group-a and joins group-b.
    const root = layout.grid.root as Grid & {
      data: Array<{ data: { id: string; views: string[] } }>;
    };
    root.data[0]!.data.views = [];
    root.data[1]!.data.views = ["chat:b", "chat:a"];

    const storage = fakeStorage();
    saveLayout(layout, undefined, storage);
    const restored = loadLayout(undefined, ["chat:a", "chat:b"], storage);
    expect(restored).not.toBeNull();

    const { container, root: reactRoot } = renderLayout(restored!);
    try {
      const panelA = container.querySelector<HTMLElement>('[data-panel-id="chat:a"]');
      expect(panelA).not.toBeNull();
      expect(panelA!.closest('[data-testid="group"]')!.getAttribute("data-group-id")).toBe(
        "group-b",
      );
      expect(panelA!.getAttribute("data-param-keys")).toBe("contentType,tabKey");
      // chat:b survives the move with its own identity intact.
      expect(container.querySelector('[data-panel-id="chat:b"]')).not.toBeNull();
    } finally {
      cleanup(container, reactRoot);
    }
  });
});
