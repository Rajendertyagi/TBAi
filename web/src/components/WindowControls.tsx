import { Minus, Square, X } from "lucide-react";
import {
  isTauri,
  windowClose,
  windowMinimize,
  windowToggleMaximize,
} from "../lib/platform";

const btn =
  "flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-muted";

/**
 * Native window controls (minimize / maximize / close). Rendered only inside the
 * Tauri desktop shell; returns null in the browser so the web app is untouched.
 */
export function WindowControls() {
  if (!isTauri()) return null;
  return (
    <div className="flex h-full items-stretch">
      <button type="button" className={btn} title="Minimize" onClick={() => void windowMinimize()}>
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={btn}
        title="Maximize"
        onClick={() => void windowToggleMaximize()}
      >
        <Square className="h-3 w-3" />
      </button>
      <button
        type="button"
        className="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
        title="Close"
        onClick={() => void windowClose()}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
