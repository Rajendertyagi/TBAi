/**
 * Workspace surface persistence across route changes (audit M2).
 *
 * The persistent Dockview layer must never be unmounted or collapsed to zero
 * size when the user navigates to a non-chat route (settings/scheduler) and
 * back. This DOM test proves the STRUCTURAL invariant that guarantees that in
 * a real browser: the workspace element keeps the same DOM node and retains
 * layout-preserving classes (`absolute inset-0`, never `hidden`) across the
 * toggle. True pixel-size measurement requires a real layout engine and is a
 * Playwright E2E concern; happy-dom has no layout, so asserting the class
 * invariant is the strongest deterministic DOM-level proof available.
 */
import { describe, it, expect } from "bun:test";
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { routeSurfaceClass, workspaceSurfaceClass } from "@web/features/workspace/routeFocus";

/** Harness mirroring AppShell's two-layer surface composition. */
function SurfaceHarness({ onReady }: { onReady: (api: HarnessApi) => void }) {
  const [isChat, setIsChat] = useState(true);
  onReady({ setIsChat: (v: boolean) => act(() => setIsChat(v)) });
  return (
    <div className="relative flex h-full min-h-0 flex-row">
      <div
        className={workspaceSurfaceClass(isChat)}
        data-testid="workspace-surface"
        aria-hidden={!isChat}
      >
        <div data-testid="dockview-workspace">workspace</div>
      </div>
      <div className={routeSurfaceClass(isChat)} data-testid="route-surface">
        route
      </div>
    </div>
  );
}

interface HarnessApi {
  setIsChat: (v: boolean) => void;
}

function mountHarness(): { container: HTMLElement; root: Root; api: HarnessApi } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let api!: HarnessApi;
  const root = createRoot(container);
  act(() => {
    root.render(<SurfaceHarness onReady={(a) => (api = a)} />);
  });
  return { container, root, api };
}

function surface(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="workspace-surface"]');
  if (!el) throw new Error("workspace surface not found");
  return el;
}

describe("workspace surface persistence across routes (audit M2)", () => {
  it("keeps the same workspace DOM node across chat → scheduler → chat", () => {
    const { container, root, api } = mountHarness();
    try {
      const initial = surface(container);
      expect(initial.getAttribute("aria-hidden")).toBe("false");

      // Navigate away: workspace is visually hidden but NOT unmounted.
      api.setIsChat(false);
      const hidden = surface(container);
      expect(hidden).toBe(initial); // same node identity — never unmounted
      expect(hidden.getAttribute("aria-hidden")).toBe("true");

      // Navigate back: still the same node, visible again.
      api.setIsChat(true);
      const shown = surface(container);
      expect(shown).toBe(initial);
      expect(shown.getAttribute("aria-hidden")).toBe("false");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("never applies display:none and always keeps layout-preserving classes", () => {
    const { container, root, api } = mountHarness();
    try {
      for (const isChat of [true, false, true]) {
        api.setIsChat(isChat);
        const el = surface(container);
        const cls = el.className;
        expect(cls).toContain("absolute");
        expect(cls).toContain("inset-0");
        expect(cls).not.toContain("hidden"); // display:none would collapse Dockview
        expect(cls).toContain(isChat ? "visible" : "invisible");
      }
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("keeps the route surface pointer-transparent only on chat surfaces", () => {
    const { container, root, api } = mountHarness();
    try {
      const route = () => container.querySelector<HTMLElement>('[data-testid="route-surface"]')!;
      expect(route().className).toContain("pointer-events-none");
      api.setIsChat(false);
      expect(route().className).not.toContain("pointer-events-none");
      api.setIsChat(true);
      expect(route().className).toContain("pointer-events-none");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
