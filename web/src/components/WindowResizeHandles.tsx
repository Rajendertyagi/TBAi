import { useEffect, useState, type CSSProperties } from "react";
import {
  isTauri,
  isLinux,
  windowStartResizeDragging,
  type ResizeDir,
} from "../lib/platform";
import {
  WINDOW_CONTROLS_WIDTH,
  EDGE_GRIP,
  CORNER_GRIP,
  CONTROLS_HEIGHT,
} from "../lib/window-chrome";

/**
 * Invisible edge/corner resize handles for undecorated Linux windows.
 *
 * Only Linux needs this: macOS keeps native resizing via the overlay title bar,
 * and Windows gets invisible resize borders from Tauri's WndProc hook. Undecorated
 * GTK windows, however, lose edge resizing entirely, so we reproduce it by
 * initiating a window-manager resize drag on mouse-down.
 *
 * Mounted once at the app root; it self-guards and renders nothing unless the
 * current window is a resizable, non-maximized Linux desktop window.
 */

type Grip = { dir: ResizeDir; cursor: string; style: CSSProperties };

const GRIPS: Grip[] = [
  // Edges. The top edge stops before the controls strip so the close button
  // stays fully clickable; the right edge starts below the controls bar.
  {
    dir: "North",
    cursor: "ns-resize",
    style: { top: 0, left: 0, right: WINDOW_CONTROLS_WIDTH, height: EDGE_GRIP },
  },
  {
    dir: "South",
    cursor: "ns-resize",
    style: { bottom: 0, left: 0, right: 0, height: EDGE_GRIP },
  },
  {
    dir: "West",
    cursor: "ew-resize",
    style: { top: 0, bottom: 0, left: 0, width: EDGE_GRIP },
  },
  {
    dir: "East",
    cursor: "ew-resize",
    style: { top: CONTROLS_HEIGHT, bottom: 0, right: 0, width: EDGE_GRIP },
  },
  // Corners (NorthEast is omitted — the window controls occupy that corner).
  {
    dir: "NorthWest",
    cursor: "nwse-resize",
    style: { top: 0, left: 0, width: CORNER_GRIP, height: CORNER_GRIP },
  },
  {
    dir: "SouthWest",
    cursor: "nesw-resize",
    style: { bottom: 0, left: 0, width: CORNER_GRIP, height: CORNER_GRIP },
  },
  {
    dir: "SouthEast",
    cursor: "nwse-resize",
    style: { bottom: 0, right: 0, width: CORNER_GRIP, height: CORNER_GRIP },
  },
];

export function WindowResizeHandles() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!isLinux() || !isTauri()) {
      setEnabled(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      const win = getCurrentWindow();

      // Non-resizable windows (e.g. a future pet panel) get no grips.
      let resizable = true;
      try {
        resizable = await win.isResizable();
      } catch {
        resizable = true;
      }
      if (disposed || !resizable) {
        setEnabled(false);
        return;
      }

      const sync = async () => {
        try {
          const maximized = await win.isMaximized();
          if (!disposed) setEnabled(!maximized);
        } catch {
          if (!disposed) setEnabled(true);
        }
      };

      await sync();
      win
        .onResized(() => void sync())
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        })
        .catch(() => {
          unlisten = null;
        });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!enabled) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[100]">
      {GRIPS.map((grip) => (
        <div
          key={grip.dir}
          className="pointer-events-auto absolute"
          style={{ ...grip.style, cursor: grip.cursor }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void windowStartResizeDragging(grip.dir);
          }}
        />
      ))}
    </div>
  );
}
