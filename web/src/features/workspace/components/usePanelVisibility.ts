/**
 * Tracks Dockview panel visibility for OPTIONAL visual work only.
 *
 * There is no `DockviewApi.onDidVisibilityChange`; visibility is per panel via
 * `panel.api.onDidVisibilityChange`. Hidden `renderer:"always"` panels keep
 * their DOM and browser-driven work alive — this hook never pauses execution,
 * streaming or subscriptions. It only exposes a boolean for DOM-level state
 * (e.g. a `data-visible` attribute) so visual work can be skipped when hidden.
 */
import { useEffect, useState } from "react";
import type { DockviewPanelApi } from "dockview-react";

/** Subscribe to a panel's visibility changes; returns its current visibility. */
export function usePanelVisibility(api: DockviewPanelApi): boolean {
  const [visible, setVisible] = useState(() => api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const disposable = api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => disposable.dispose();
  }, [api]);
  return visible;
}
