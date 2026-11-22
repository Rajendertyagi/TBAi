/**
 * Defensive duplicate-mount guard for runtime-bearing panels.
 *
 * Dockview guarantees unique panel ids, but two panels with different ids could
 * carry the same canonical tab key and mount two live runtimes for one
 * conversation. Claiming by tab key makes the second host render a safe
 * placeholder instead. The claim is released on unmount (idempotent).
 *
 * The claim is acquired in an effect, not a render-phase state initializer:
 * StrictMode double-invokes render, so a render-phase claim would leak a
 * never-released claim from the discarded render. Effect setup/cleanup pairs
 * are balanced by React, so the claim survives StrictMode remounts.
 */
import { useEffect, useState } from "react";
import { panelRegistry } from "../panelRegistry";

/** Returns true when this component owns the host for `tabKey`. */
export function usePanelMountClaim(tabKey: string): boolean {
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    const acquired = panelRegistry.claim(tabKey);
    setOwned(acquired);
    return () => {
      if (acquired) panelRegistry.release(tabKey);
    };
  }, [tabKey]);
  return owned;
}
