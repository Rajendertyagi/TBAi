import { useCallback, useEffect, useRef, useState } from "react";
import { unstable_useComposerInput } from "@assistant-ui/react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import {
  welcomeConfig,
  type QuickActionAccent,
  type QuickActionItem,
} from "@/config/welcome";
import { useWelcomeScopeStore } from "@/features/chat/state/welcomeScope";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Codeg parity quick actions (read from `config/welcome.ts` — no literals).
 * Tab bar mirrors the pill treatment, featured items render as accent
 * `BigCard`s, the remainder rides a bounded `SkillRail` with arrows.
 * Clicking a card fills the app's single composer (plain-text injection;
 * Codeg's skill-badge pipeline is an intentional scope cut).
 */

// Static accent fragments — full literals so Tailwind's JIT keeps them
// (never compose color classes from template strings).
const ACCENTS: Record<QuickActionAccent, { icon: string; surface: string }> = {
  green: {
    icon: "text-green-600 dark:text-green-400",
    surface:
      "border-green-500/20 hover:border-green-500/40 hover:bg-green-500/5",
  },
  blue: {
    icon: "text-blue-600 dark:text-blue-400",
    surface: "border-blue-500/20 hover:border-blue-500/40 hover:bg-blue-500/5",
  },
  orange: {
    icon: "text-orange-600 dark:text-orange-400",
    surface:
      "border-orange-500/20 hover:border-orange-500/40 hover:bg-orange-500/5",
  },
  amber: {
    icon: "text-amber-600 dark:text-amber-400",
    surface:
      "border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5",
  },
  pink: {
    icon: "text-pink-600 dark:text-pink-400",
    surface:
      "border-pink-500/20 hover:border-pink-500/40 hover:bg-pink-500/5",
  },
  purple: {
    icon: "text-purple-600 dark:text-purple-400",
    surface:
      "border-purple-500/20 hover:border-purple-500/40 hover:bg-purple-500/5",
  },
  violet: {
    icon: "text-violet-600 dark:text-violet-400",
    surface:
      "border-violet-500/20 hover:border-violet-500/40 hover:bg-violet-500/5",
  },
};

function BigCard({ item, onSelect }: { item: QuickActionItem; onSelect: () => void }) {
  const a = ACCENTS[item.accent];
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex flex-col items-start gap-1.5 rounded-lg border bg-card/50 px-3 py-2.5 text-left transition-colors",
        a.surface,
      )}
    >
      <Icon aria-hidden="true" className={cn("h-4 w-4 transition-colors", a.icon)} />
      <span className="text-sm font-medium text-foreground">{item.title}</span>
      <span className="line-clamp-1 text-xs text-muted-foreground">
        {item.description}
      </span>
    </button>
  );
}

function SkillBar({ item, onSelect }: { item: QuickActionItem; onSelect: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={item.description}
      className="group flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2 transition-colors hover:border-foreground/20 hover:bg-accent/40"
    >
      <Icon
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
      />
      <span className="whitespace-nowrap text-xs font-medium text-foreground/90">
        {item.title}
      </span>
    </button>
  );
}

const RAIL_STEP_RATIO = 0.4;

function RailArrow({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
        "border border-border bg-card/50 text-muted-foreground transition-colors",
        "hover:border-foreground/20 hover:bg-accent/40 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-35",
      )}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}

/** Bounded horizontal rail: arrows live exactly while scroll runway remains. */
function SkillRail({ items, onSelect }: { items: QuickActionItem[]; onSelect: (item: QuickActionItem) => void }) {
  const copy = welcomeConfig.copy;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canStart, setCanStart] = useState(false);
  const [canEnd, setCanEnd] = useState(false);

  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const travelled = Math.abs(el.scrollLeft);
    const max = el.scrollWidth - el.clientWidth;
    setCanStart(travelled > 1);
    setCanEnd(travelled < max - 1);
  }, []);

  useEffect(() => {
    measure();
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    ro.observe(track);
    return () => ro.disconnect();
  }, [measure, items.length]);

  if (items.length === 0) return null;

  const nudge = (direction: 1 | -1) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollBy({
      left: Math.max(120, el.clientWidth * RAIL_STEP_RATIO) * direction,
      behavior: "smooth",
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      <RailArrow
        icon={ChevronLeft}
        label={copy.railPrev}
        onClick={() => nudge(-1)}
        disabled={!canStart}
      />
      <div
        ref={viewportRef}
        onScroll={measure}
        className="min-w-0 flex-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div ref={trackRef} className="flex w-max gap-2">
          {items.map((item) => (
            <SkillBar key={item.id} item={item} onSelect={() => onSelect(item)} />
          ))}
        </div>
      </div>
      <RailArrow
        icon={ChevronRight}
        label={copy.railNext}
        onClick={() => nudge(1)}
        disabled={!canEnd}
      />
    </div>
  );
}

export function QuickActions() {
  const copy = welcomeConfig.copy;
  const layout = welcomeConfig.layout;
  const activeTab = useWelcomeScopeStore((s) => s.quickActionTab);
  const setTab = useWelcomeScopeStore((s) => s.setQuickActionTab);
  const { setText } = unstable_useComposerInput();

  const tab = welcomeConfig.tabs.find((t) => t.id === activeTab) ?? welcomeConfig.tabs[0];
  if (!tab) return null;
  const featured = tab.items.slice(0, tab.featuredCount);
  const rest = tab.items.slice(tab.featuredCount);
  const select = (item: QuickActionItem) => setText(item.prompt);

  return (
    <section aria-label={copy.quickActionsLabel} className="flex flex-col gap-2">
      <div role="tablist" aria-label={copy.quickActionsLabel} className={cn(layout.tabRowClass, "justify-center")}>
        {welcomeConfig.tabs.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab.id;
          return (
            <Button
              key={t.id}
              role="tab"
              aria-selected={active}
              type="button"
              variant={active ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTab(t.id)}
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {t.label}
            </Button>
          );
        })}
      </div>
      {featured.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {featured.map((item) => (
            <BigCard key={item.id} item={item} onSelect={() => select(item)} />
          ))}
        </div>
      )}
      <SkillRail items={rest} onSelect={select} />
    </section>
  );
}
