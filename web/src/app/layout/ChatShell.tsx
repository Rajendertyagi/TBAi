import { useEffect } from "react";
import { DevToolsGate } from "../../components/DevToolsGate";
import { useSettingsStore } from "@/features/providers/state/providersStore";
import { logger } from "../../lib/logger";
import { Outlet } from "react-router";

/**
 * Normal-chat branch shell.
 * There is no root AssistantRuntimeProvider (removed in Phase E): each Direct
 * host mounts its own provider, the Sidebar reads the HTTP-owned activity
 * projection, and Code mode isolates via CodeShell/OpenCodeIsolationBoundary.
 *
 * Thread binding: AppShell's handleThreadIdChange binds through the owner
 * record with the live snapshot as backstop:
 *   peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine
 *
 * Code mode isolates via CodeShell and OpenCodeIsolationBoundary.
 */
export function ChatShell() {
  const { loadProviders } = useSettingsStore();
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // Runtime lifecycle: which shell owns a live runtime, and when.
  useEffect(() => {
    logger.info("app", "runtime.mount", { shell: "chat" });
    return () => logger.info("app", "runtime.unmount", { shell: "chat" });
  }, []);

  return (
    <>
      <Outlet />
      <DevToolsGate />
    </>
  );
}
