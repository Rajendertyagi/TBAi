import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { ROUTES } from "../config/routes";
import { usePreferencesStore } from "../features/preferences/state/preferencesStore";
import { useChatTabsStore } from "../features/chat/state/chatTabs";

/**
 * Landing route (`/`): waits for authoritative workspace hydration, then
 * chooses a deterministic local route for this window only.
 *
 * - Existing URL `/chat/:id` or `/code/:id` is preserved by routing (this
 *   component only handles `/`).
 * - Fresh `/` => deterministic local draft (`/chat/new`). No shared active
 *   pointer, no stale local active conversation, no arbitrary first shared tab.
 * - Hydration unavailable/failed => safe loading/error with retry; never assume empty.
 */
export function IndexRedirect() {
  const hydration = usePreferencesStore((s) => s.hydration);
  const hydrationError = usePreferencesStore((s) => s.hydrationError);
  const refresh = usePreferencesStore((s) => s.refresh);
  const start = usePreferencesStore((s) => s.start);
  const [target, setTarget] = useState<string | null>(null);

  // Ensure hydration is started (idempotent). AppShell also starts it.
  useEffect(() => {
    if (hydration === "idle") start();
  }, [hydration, start]);

  // Authoritative hydration succeeded: deterministic local draft for fresh root.
  useEffect(() => {
    if (hydration !== "ready" || target !== null) return;
    useChatTabsStore.getState().openNewDraft();
    setTarget(ROUTES.CHAT_NEW);
  }, [hydration, target]);

  if (hydration === "idle" || hydration === "loading" || (hydration === "ready" && target === null)) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading workspace.
      </div>
    );
  }

  if (hydration === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p className="text-muted-foreground">{hydrationError ?? "Failed to load workspace."}</p>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-foreground hover:bg-accent"
          onClick={() => void refresh()}
        >
          Retry
        </button>
      </div>
    );
  }

  return <Navigate to={target ?? ROUTES.CHAT_NEW} replace />;
}
