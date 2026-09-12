import { useNavigate } from "react-router";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { sidebarConfig } from "@/config/sidebar";

/**
 * Breadcrumb title strip for dedicated pages (codeg `WorkbenchPageTitle`
 * parity): back-to-conversations button, chevron, title. Transparent `h-10`
 * bar above the page content; the leading button is the way back to chats.
 * Title is passed in (callers read it from `navigation.ts` — never a literal
 * at the call site).
 */
export function PageTitleStrip({ title }: { title: string }) {
  const navigate = useNavigate();

  return (
    <div className="flex h-[var(--title-bar-height)] min-w-0 shrink-0 items-center gap-1 border-b border-border/50 pl-3">
      <button
        type="button"
        onClick={() => navigate("/chat")}
        title={sidebarConfig.copy.backToChats}
        aria-label={sidebarConfig.copy.backToChats}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <MessagesSquare aria-hidden="true" className="size-3.5" />
      </button>
      <ChevronRight
        aria-hidden="true"
        className="size-3 shrink-0 text-muted-foreground/50"
      />
      <h1 className="min-w-0 truncate pl-1 text-sm font-semibold leading-none">
        {title}
      </h1>
    </div>
  );
}
