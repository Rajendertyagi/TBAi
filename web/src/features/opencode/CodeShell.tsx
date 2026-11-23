import { useEffect } from "react";
// AppShell is the universal parent (see router.tsx). CodeShell provides only
// the Code-mode route lifecycle; the OpenCode runtime itself lives in the
// persistent Dockview workspace's OpenCodePanel (Phase E).
import { useSettingsStore } from "@/features/providers/state/providersStore";
import { logger } from "@/lib/logger";
import { OpenCodeView } from "./OpenCodeView";

/**
 * Code-mode surface shell. Uses the unified `AppShell` so all application
 * chrome (Sidebar, TabStrip, StatusBar, WindowControls, Edge Chrome) renders.
 * In Phase E the OpenCode host is mounted by the persistent Dockview
 * `OpenCodePanel` with its own `OpenCodeIsolationBoundary` (`AuiProvider
 * extends={null}`) and provider; `OpenCodeView` is a thin route trigger.
 */
export function CodeShell() {
  const { loadProviders } = useSettingsStore();
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // Runtime lifecycle: which shell owns a live runtime, and when. The two
  // shells are a hard architectural boundary, so "which runtime was mounted"
  // is load-bearing evidence when a lifecycle breaks.
  useEffect(() => {
    logger.info("app", "runtime.mount", { shell: "code" });
    return () => logger.info("app", "runtime.unmount", { shell: "code" });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <OpenCodeView />
    </div>
  );
}
