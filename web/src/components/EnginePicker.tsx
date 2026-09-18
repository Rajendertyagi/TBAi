import { welcomeConfig } from "@/config/welcome";
import { cn } from "@/lib/utils";
import type { WelcomeEngine } from "@/features/chat/state/welcomeEngine";

/**
 * Controlled Direct/OpenCode pill switch. Presentational only — the caller
 * owns the value (welcome draft store, dialog-local state, …). Shared by the
 * welcome draft picker and every creation flow that must offer an engine
 * choice, so engine selection looks and behaves identically everywhere.
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
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) onChange(opt.id);
              }}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm transition-colors outline-none",
                "focus-visible:ring-1 focus-visible:ring-ring",
                active
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
