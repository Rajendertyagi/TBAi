import { useEffect } from "react";
// AppShell is now the universal parent (see router.tsx). CodeShell provides
// only the OpenCode runtime and renders OpenCodeView.
import { useSettingsStore } from "@/features/providers/state/providersStore";
import { logger } from "@/lib/logger";
import { OpenCodeView } from "./OpenCodeView";

/**
 * OpenCode surface shell. Uses the unified `AppShell` so all application
 * chrome (Sidebar, TabStrip, StatusBar, WindowControls, Edge Chrome) renders,
 * while wrapping `OpenCodeView` inside `OpenCodeIsolationBoundary` (`AuiProvider extends={null}`)
 * to cut off ambient assistant-ui context so OpenCode establishes its own isolated runtime.
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
