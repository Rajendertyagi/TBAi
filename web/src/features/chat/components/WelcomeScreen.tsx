import { useMemo, type ReactNode } from "react";
import { welcomeConfig } from "@/config/welcome";
import { cn } from "@/lib/utils";
import { WelcomeHero } from "./WelcomeHero";
import { QuickActions } from "./QuickActions";
import { WelcomeScopePicker } from "./WelcomeScopePicker";

/** Composer-less welcome column. The app's single composer instance is
 *  injected via the `composer` slot by ChatWindow (one tag, one mount). */
export function WelcomeScreen({ composer }: { composer: ReactNode }) {
  const layout = welcomeConfig.layout;
  const copy = welcomeConfig.copy;
  const tip = useMemo(() => {
    if (copy.tips.length === 0) return null;
    const day = new Date().getDate();
    return copy.tips[day % copy.tips.length] ?? null;
  }, [copy.tips]);

  return (
    <div
      aria-label={copy.newChatAria}
      className="flex h-full min-h-0 items-center justify-center overflow-y-auto"
    >
      <div
        className={cn(
          "flex w-full flex-col",
          layout.columnMaxWidthClass,
          layout.columnPaddingClass,
          layout.columnGapClass,
          "py-8",
        )}
      >
        <WelcomeHero />
        <QuickActions />
        <div className="flex flex-col">
          {composer}
          <div className="px-1 pt-1">
            <WelcomeScopePicker editable />
          </div>
        </div>
        {tip && <p className={cn(layout.tipClass, "text-center")}>{tip}</p>}
      </div>
    </div>
  );
}
