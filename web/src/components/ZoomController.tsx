import { useEffect } from "react";
import { toast } from "sonner";
import { isComposing } from "../lib/ime";
import {
  clampWindowZoom,
  getTargetWindowZoom,
  isTauri,
  readWindowZoom,
  requestWindowZoom,
  WINDOW_ZOOM_PRESETS,
} from "../lib/platform";

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  if (target.closest("[contenteditable='true']")) return true;
  if (target.closest(".monaco-editor")) return true;
  return false;
}

/**
 * Global Window Zoom Controller (desktop/Tauri only):
 * 1. Restores the last successfully applied native window zoom on startup.
 * 2. Handles global keyboard shortcuts (Ctrl/Cmd +, -, 0) by stepping presets.
 *    - Steps from the latest requested zoom target so rapid presses do not race stale state.
 *    - Ignored during text editing / IME composition and on interactive targets.
 *    - Never intercepts browser-native zoom shortcuts outside Tauri.
 *    - Shows a success toast only when native zoom is actually applied; superseded requests are silent.
 */
export function ZoomController() {
  useEffect(() => {
    if (!isTauri()) return;

    // Restore the last successfully applied native zoom (no toast; fail safely).
    void requestWindowZoom(readWindowZoom());

    const onKeyDown = (e: KeyboardEvent) => {
      if (isComposing(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      const key = e.key;
      const isZoomIn = key === "+" || key === "=";
      const isZoomOut = key === "-";
      const isZoomReset = key === "0";

      if (!isZoomIn && !isZoomOut && !isZoomReset) return;

      if (isInteractiveTarget(e.target)) return;

      e.preventDefault();

      // Step from the latest requested target (not only persisted) so rapid shortcuts stay ordered.
      const current = getTargetWindowZoom();
      let next = current;

      if (isZoomReset) {
        next = 1.0;
      } else if (isZoomIn) {
        const found = WINDOW_ZOOM_PRESETS.find((p) => p > current + 0.001);
        next = found !== undefined ? found : WINDOW_ZOOM_PRESETS[WINDOW_ZOOM_PRESETS.length - 1];
      } else if (isZoomOut) {
        const reversed = [...WINDOW_ZOOM_PRESETS].reverse();
        const found = reversed.find((p) => p < current - 0.001);
        next = found !== undefined ? found : WINDOW_ZOOM_PRESETS[0];
      }

      next = clampWindowZoom(next);
      void (async () => {
        const result = await requestWindowZoom(next);
        if (result.status === "applied") {
          toast.info(`Zoom: ${Math.round(result.zoom * 100)}%`, {
            id: "window-zoom-toast",
            duration: 1200,
          });
        } else if (result.status === "failed") {
          toast.error("Could not apply window zoom.", { id: "window-zoom-toast" });
        }
        // superseded: a newer shortcut won; no misleading toast.
      })();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  return null;
}
