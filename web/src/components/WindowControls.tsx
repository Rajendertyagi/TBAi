import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import {
  isTauri,
  onWindowResized,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from "../lib/platform";
import { chromeConfig } from "../config/chrome";
import { cn } from "../lib/utils";

const BTN_CLASS =
  "flex h-full w-[var(--caption-button-width)] items-center justify-center text-muted-foreground transition-colors hover:bg-muted";

/**
 * Native window controls (minimize / maximize-restore / close) for the
 * frameless Windows desktop shell. Rendered only inside Tauri; returns null
 * in the browser so the web app is untouched. Tracks maximized state (via
 * `onResized`) to swap the Maximize ⇄ Restore glyph and labels.
 */
export function WindowControls() {
  const copy = chromeConfig.copy;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    windowIsMaximized()
      .then((v) => {
        if (!disposed) setIsMaximized(v);
      })
      .catch(() => {
        if (!disposed) setIsMaximized(false);
      });
    onWindowResized(() => {
      windowIsMaximized()
        .then((v) => {
          if (!disposed) setIsMaximized(v);
        })
        .catch(() => {});
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {
        unlisten = null;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null;
  return (
    <div className="flex h-full items-stretch">
      <button
        type="button"
        className={BTN_CLASS}
        title={copy.minimize}
        aria-label={copy.minimize}
        onClick={() => void windowMinimize()}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={BTN_CLASS}
        title={isMaximized ? copy.restore : copy.maximize}
        aria-label={isMaximized ? copy.restore : copy.maximize}
        aria-pressed={isMaximized}
        onClick={() => void windowToggleMaximize()}
      >
        {isMaximized ? (
          <Copy className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Square className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={cn(
          BTN_CLASS,
          "hover:bg-destructive hover:text-destructive-foreground",
        )}
        title={copy.close}
        aria-label={copy.close}
        onClick={() => void windowClose()}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
