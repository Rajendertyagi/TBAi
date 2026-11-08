import { useNavigate } from "react-router";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { sidebarConfig } from "@/config/sidebar";
import { ROUTES } from "@/config/navigation";
import { cn } from "@/lib/utils";

/**
 * Breadcrumb title strip for dedicated pages (codeg `WorkbenchPageTitle`
 * parity): back-to-conversations button, chevron, title. Transparent `h-10`
 * bar above the page content; the leading button is the way back to chats.
 * Title is passed in (callers read it from `navigation.ts` — never a literal
 * at the call site).
 *
 * `titleAs` decides who owns the page's single `h1`. On Scheduler the strip IS
 * the page title, so it renders the heading. On settings routes the section
 * page below the strip owns the `h1` and the strip repeats the name as chrome,
 * so it renders a `span`. The size follows the role: a heading is `text-base`,
 * chrome is `text-sm`.
 */
export function PageTitleStrip({
  title,
  titleAs = "h1",
}: {
  title: string;
  titleAs?: "h1" | "span";
}) {
  const navigate = useNavigate();
  const Title = titleAs;

  return (
    <div
      data-slot="page-title-strip"
      className="flex h-[var(--title-bar-height)] min-w-0 shrink-0 items-center gap-1 border-b border-border/50 pl-3"
    >
      <button
        type="button"
        onClick={() => navigate(ROUTES.CHAT)}
        title={sidebarConfig.copy.backToChats}
        aria-label={sidebarConfig.copy.backToChats}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <MessagesSquare aria-hidden="true" className="size-3.5" />
      </button>
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/50" />
      <Title
        className={cn(
          "min-w-0 truncate pl-1 font-semibold leading-none",
          titleAs === "h1" ? "text-base" : "text-sm",
        )}
      >
        {title}
      </Title>
    </div>
  );
}
