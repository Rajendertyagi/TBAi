import { Circle } from "lucide-react";
import { isTauri } from "../lib/platform";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { useSettingsStore } from "../stores/index";

/**
 * VS Code–style bottom status bar. Shows the active provider + model and a
 * local-connection indicator. Rendered only in the Tauri shell and only when
 * the user hasn't hidden it (Desktop settings). In the browser it returns null,
 * so no desktop-only code reaches the web bundle.
 */
export function StatusBar() {
  const visible = useDesktopLayout((s) => s.statusBarVisible);
  if (!isTauri() || !visible) return null;

  const providers = useSettingsStore((s) => s.providers);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const selectedProviderId = useSettingsStore((s) => s.selectedProviderId);
  const selectedModelId = useSettingsStore((s) => s.selectedModelId);

  const providerId = selectedProviderId ?? activeProviderId;
  const provider = providers.find((p) => p.id === providerId);
  const modelLabel =
    (selectedModelId
      ? provider?.models?.find((m) => m.id === selectedModelId)?.label
      : undefined) ?? provider?.model;
  const statusLabel = provider
    ? `${provider.name}${modelLabel ? ` · ${modelLabel}` : ""}`
    : "No provider configured";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-primary px-3 text-xs text-primary-foreground">
      <span className="flex items-center gap-1.5">
        <Circle className="h-2 w-2 fill-current" />
        Local
      </span>
      <span className="opacity-70">TBAi</span>
      <span className="ml-auto max-w-[60%] truncate opacity-90" title={statusLabel}>
        {statusLabel}
      </span>
    </footer>
  );
}
