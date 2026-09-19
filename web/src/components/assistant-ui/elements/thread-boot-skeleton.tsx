import { historyConfig } from "@/config/history";

/**
 * Lightweight boot skeleton for a persisted thread whose history has not
 * resolved yet. Rendered inside the messages viewport (never Welcome);
 * unmounts the moment history settles. Copy comes from `historyConfig`.
 *
 * Shared by the Direct chat surface (`ChatWindow`) and the OpenCode surface
 * (`OpenCodeView`) so a loading conversation reads identically everywhere.
 */
export function ThreadBootSkeleton() {
  return (
    <div
      data-testid="thread-boot"
      role="status"
      aria-label={historyConfig.copy.loadingConversation}
      className="space-y-4"
    >
      <div className="ml-auto h-10 w-2/5 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 w-4/5 animate-pulse rounded-xl bg-muted" />
      <div className="ml-auto h-10 w-1/3 animate-pulse rounded-xl bg-muted" />
      <div className="h-16 w-3/5 animate-pulse rounded-xl bg-muted" />
      <span className="sr-only">{historyConfig.copy.loadingConversation}</span>
    </div>
  );
}