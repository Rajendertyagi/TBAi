import { isTauri, windowStartResizing, type Edge } from "../lib/platform";

/**
 * Thin left/right edge grips that initiate a native window resize. Tauri-only —
 * returns null in the browser so the web app is untouched. These replace the old
 * `LeftEdgeChrome` / `RightEdgeChrome` resize handles (those components are now
 * the floating corner toggle clusters, mirroring codeg).
 */
export function WindowResizeHandles() {
  if (!isTauri()) return null;
  return (
    <>
      <div
        aria-hidden
        onPointerDown={() => void windowStartResizing("left" as Edge)}
        className="fixed left-0 top-0 z-50 h-full w-1 cursor-ew-resize"
      />
      <div
        aria-hidden
        onPointerDown={() => void windowStartResizing("right" as Edge)}
        className="fixed right-0 top-0 z-50 h-full w-1 cursor-ew-resize"
      />
    </>
  );
}
