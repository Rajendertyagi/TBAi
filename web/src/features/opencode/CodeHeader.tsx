import { useNavigate } from "react-router";
import { ChevronLeft } from "lucide-react";

/**
 * Focused Code-shell chrome: back navigation plus the surface label. Points
 * at a fresh draft (never at a tab that may not exist here) and uses only
 * router + config — no assistant-ui runtime, so it stays valid above the
 * OpenCode provider boundary.
 */
export function CodeHeader() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-1 px-2">
      <button
        type="button"
        onClick={() => navigate("/chat/new")}
        title="Back to chats"
        aria-label="Back to chats"
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
      </button>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        Code
      </span>
    </div>
  );
}
