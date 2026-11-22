/**
 * WorkspaceSurface — stable runtime hosts across position changes.
 *
 * The defect this guards: moving a chat between workspace positions must not
 * reparent or remount its runtime-bearing host. The implementation renders each
 * host as a stable, keyed sibling and changes only CSS `order`. These tests
 * mount the real surface in happy-dom with a marker host that records mount /
 * unmount, then assert node identity survives a move and that closing one panel
 * disposes only that host.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Marker host: exposes the thread it was given. Host identity is asserted via
// DOM node identity, which is the real signal that React did not remount it.
mock.module("@web/features/workspace/components/DirectChatHost", () => ({
  DirectChatHost: ({ threadId }: { threadId: string }) => (
    <div data-testid="host" data-thread={threadId} />
  ),
}));

const { WorkspaceSurface } = await import("@web/features/workspace/components/WorkspaceSurface");
const { useWorkspacePanels } = await import("@web/features/workspace/state/workspacePanels");

interface Mounted {
  container: HTMLElement;
  render(): Promise<void>;
  unmount(): void;
}

const mounted: Mounted[] = [];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Mutate the panel store inside act so React sees the update. */
function panels(fn: () => void): void {
  act(() => fn());
}

async function mount(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(<WorkspaceSurface />);
    });
    await settle();
  };
  await render();
  const handle: Mounted = {
    container,
    render,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

function hosts(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="host"]'));
}

function panelWrappers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-panel-id]"));
}

beforeEach(() => {
  useWorkspacePanels.setState({ panels: [] });
});

afterEach(() => {
  for (const m of mounted) m.unmount();
  mounted.length = 0;
  useWorkspacePanels.setState({ panels: [] });
});

describe("WorkspaceSurface stable hosts", () => {
  it("renders one host per chat panel", async () => {
    panels(() => {
      useWorkspacePanels.getState().openPanel("chat:conv-A");
      useWorkspacePanels.getState().openPanel("chat:conv-B");
    });
    const m = await mount();
    expect(hosts(m.container)).toHaveLength(2);
    expect(
      hosts(m.container)
        .map((h) => h.dataset.thread)
        .sort(),
    ).toEqual(["conv-A", "conv-B"]);
  });

  it("moving a panel changes CSS order but keeps the SAME host DOM node", async () => {
    panels(() => {
      useWorkspacePanels.getState().openPanel("chat:conv-A");
      useWorkspacePanels.getState().openPanel("chat:conv-B");
    });
    const m = await mount();

    const before = hosts(m.container);
    const beforeById = new Map(
      panelWrappers(m.container).map((w) => [
        w.dataset.panelId,
        { wrapper: w, host: w.querySelector<HTMLElement>('[data-testid="host"]') },
      ]),
    );
    const aId = panelWrappers(m.container)[0]?.dataset.panelId ?? "";
    const aBefore = beforeById.get(aId)?.host;
    expect(aBefore).toBeDefined();

    // Move panel A to the last position (order only).
    panels(() => useWorkspacePanels.getState().movePanel(aId, 1));
    await m.render();

    const afterById = new Map(panelWrappers(m.container).map((w) => [w.dataset.panelId, w]));
    const aAfterWrapper = afterById.get(aId);
    const aAfterHost = aAfterWrapper?.querySelector<HTMLElement>('[data-testid="host"]');
    // Same host node identity — React did not remount the runtime host.
    expect(aAfterHost).toBe(aBefore);
    // The visual order changed.
    expect(aAfterWrapper?.style.order).toBe("1");
    // Both hosts still present.
    expect(hosts(m.container)).toHaveLength(2);
    expect(before).toHaveLength(2);
  });

  it("closing one panel unmounts only that host", async () => {
    panels(() => {
      useWorkspacePanels.getState().openPanel("chat:conv-A");
      useWorkspacePanels.getState().openPanel("chat:conv-B");
    });
    const m = await mount();

    const wrappers = panelWrappers(m.container);
    const aId = wrappers[0]?.dataset.panelId ?? "";
    const bId = wrappers[1]?.dataset.panelId ?? "";
    const bHost = wrappers[1]?.querySelector<HTMLElement>('[data-testid="host"]');

    panels(() => useWorkspacePanels.getState().closePanel(aId));
    await m.render();

    const remaining = hosts(m.container);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(bHost);
    expect(panelWrappers(m.container).map((w) => w.dataset.panelId)).toEqual([bId]);
  });

  it("ignores non-chat tab keys (OpenCode keeps its own surface)", async () => {
    panels(() => useWorkspacePanels.getState().openPanel("agent:conv-X"));
    const m = await mount();
    expect(hosts(m.container)).toHaveLength(0);
  });

  it("ignores the draft tab (materialization belongs to the primary runtime)", async () => {
    panels(() => useWorkspacePanels.getState().openPanel("chat:new"));
    const m = await mount();
    expect(hosts(m.container)).toHaveLength(0);
  });
});
