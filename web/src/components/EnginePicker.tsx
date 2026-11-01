import { welcomeConfig } from "@/config/welcome";
import { cn } from "@/lib/utils";
import type { WelcomeEngine } from "@/features/chat/state/welcomeEngine";
import { ENGINES } from "@/config/engines";

/**
 * Controlled Direct/OpenCode pill switch with Paseo-style engine identity icons.
 * Shared by the welcome draft picker and every creation flow that offers an engine choice.
 */
export function EnginePicker({
  value,
  onChange,
}: {
  value: WelcomeEngine;
  onChange: (engine: WelcomeEngine) => void;
}) {
  const copy = welcomeConfig.copy;
  const options: { id: WelcomeEngine; label: string }[] = [
    { id: "direct", label: copy.engineDirect },
    { id: "opencode", label: copy.engineOpenCode },
  ];

  return (
    <div className="flex justify-center" role="group" aria-label={copy.engineLabel}>
      <div className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 p-1">
        {options.map((opt) => {
          const active = value === opt.id;
          const visual = ENGINES[opt.id];
          const Icon = visual.icon;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) onChange(opt.id);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors outline-none",
                "focus-visible:ring-1 focus-visible:ring-ring",
                active
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className={cn("size-3.5 shrink-0", visual.badgeClass)} />
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
