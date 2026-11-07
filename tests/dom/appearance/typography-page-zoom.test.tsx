import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type SetZoom = (zoom: number) => Promise<void>;
let setZoomImpl: SetZoom = async () => {};

mock.module("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: async (zoom: number) => setZoomImpl(zoom),
  }),
}));

mock.module("sonner", () => ({
  toast: {
    success: () => {},
    error: () => {},
    info: () => {},
  },
}));

const platform = await import("@web/lib/platform");
const { TypographyPage } = await import("@web/features/appearance/TypographyPage");

function setTauri(enabled: boolean) {
  if (enabled) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TypographyPage window zoom (DOM)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    setTauri(false);
    setZoomImpl = async () => {};
    platform.__resetZoomQueueForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    setTauri(false);
    window.localStorage.clear();
  });

  it("in Tauri mode, cross-document storage event does not overwrite confirmed native zoom", async () => {
    setTauri(true);
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1");
    platform.__resetZoomQueueForTests();
    await platform.requestWindowZoom(1.5);
    // Simulate stale persisted value (e.g. best-effort write failed elsewhere).
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1");

    await act(async () => {
      root.render(<TypographyPage />);
    });
    await flush();

    expect(container.textContent).toContain("Current zoom: 150%");

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: platform.WINDOW_ZOOM_STORAGE_KEY,
          newValue: "1",
          storageArea: window.localStorage,
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain("Current zoom: 150%");
  });

  it("in browser mode, cross-document storage event syncs displayed zoom", async () => {
    setTauri(false);
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1");
    platform.__resetZoomQueueForTests();

    await act(async () => {
      root.render(<TypographyPage />);
    });
    await flush();
    expect(container.textContent).toContain("100%");

    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1.25");
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: platform.WINDOW_ZOOM_STORAGE_KEY,
          newValue: "1.25",
          storageArea: window.localStorage,
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain("125%");
  });

  it("does not revert to stale persisted zoom after a native failure", async () => {
    setTauri(true);
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1");
    platform.__resetZoomQueueForTests();
    await platform.requestWindowZoom(1.5);
    // Make persisted stale while confirmed remains 1.5.
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1");
    setZoomImpl = async () => {
      throw new Error("native fail");
    };

    await act(async () => {
      root.render(<TypographyPage />);
    });
    await flush();
    expect(container.textContent).toContain("150%");

    // Trigger a zoom request through the platform (same path UI uses) and ensure
    // confirmed state remains authoritative.
    await act(async () => {
      await platform.requestWindowZoom(1.75);
    });
    await flush();

    expect(platform.getConfirmedWindowZoom()).toBe(1.5);
    // TypographyPage listens to confirmed changes via onWindowZoomChange; a failed
    // request does not emit a confirmed change, and its own wrapper would restore
    // confirmed on failure. The displayed value should remain 150%.
    expect(container.textContent).toContain("150%");
  });
});
