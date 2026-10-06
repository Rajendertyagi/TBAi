"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { createV2RuntimeStoreFactory } from "./v2RuntimeStore";
import type { V2ThreadController } from "./v2ThreadController";

/** React bridge for the native V2 controller and assistant-ui external store. */
export function useV2AssistantRuntime(
  controller: V2ThreadController,
  conversationId: string | null,
) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  // Built once per controller so its cache survives the per-event adapter
  // rebuilds below; a factory recreated each render would drop the cache.
  const buildStore = useMemo(
    () => createV2RuntimeStoreFactory(controller, conversationId),
    [controller, conversationId],
  );
  const adapter = useMemo(() => buildStore(state), [buildStore, state]);
  return useExternalStoreRuntime(adapter);
}

/** Provider component for surfaces that need a nested native runtime boundary. */
export function V2RuntimeProvider({
  controller,
  conversationId = null,
  children,
}: {
  readonly controller: V2ThreadController;
  readonly conversationId?: string | null;
  readonly children: (runtime: ReturnType<typeof useV2AssistantRuntime>) => ReactNode;
}) {
  const runtime = useV2AssistantRuntime(controller, conversationId);
  return <AssistantRuntimeProvider runtime={runtime}>{children(runtime)}</AssistantRuntimeProvider>;
}
