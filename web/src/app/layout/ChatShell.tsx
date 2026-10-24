import { useEffect } from "react";
import { DevToolsGate } from "../../components/DevToolsGate";
import { useSettingsStore } from "@/features/providers/state/providersStore";
import { logger } from "../../lib/logger";
import { Outlet } from "react-router";

/**
 * Normal-chat branch shell.
 * AssistantRuntimeProvider is mounted once at root in AppShell using canonical
 * `threadListAdapter` so Sidebar and Chat views share the official thread-list
 * runtime without duplication.
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
