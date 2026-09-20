import { useEffect } from "react";
import { useNavigate, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";

/**
 * Root route error boundary. Catches render crashes anywhere under the app
 * shell (e.g. a transport failure that leaves runtime state inconsistent)
 * and offers recovery instead of React Router's dead default page.
 *
 * Deliberately imports nothing from assistant-ui: a crashing runtime must
 * never be a dependency of the recovery screen itself. (The logger is safe —
 * its chain is logger → transport → operation, all dependency-free.)
 *
 * It also RECORDS the crash: the boundary previously rendered a recovery
 * screen and logged nothing, so a white-screen recovery left no evidence at
 * all. The error is logged before the UI is offered.
 */
export function RouteError() {
  const navigate = useNavigate();
  const error = useRouteError();

  const message =
    error instanceof Error ? error.message : "Something went wrong.";

  useEffect(() => {
    logger.error("app", "boundary_error", {
      message,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }, [error, message]);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        Something went wrong
      </h1>
      <p className="max-w-md truncate text-sm text-muted-foreground" title={message}>
        {message}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => navigate("/chat/new")}>
          New chat
        </Button>
        <Button onClick={() => window.location.reload()}>Reload app</Button>
      </div>
    </div>
  );
}
