import { Circle, Settings } from "lucide-react";
import { useNavigate } from "react-router";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { useSettingsStore } from "../stores/index";

/**
 * VS Code–style bottom status bar. Shows the active provider + model and a
 * local-connection indicator. Items are clickable (provider → provider
 * settings, gear → desktop settings). Rendered in both the web and desktop
 * shells when the user hasn't hidden it (Desktop settings); the Tauri-only
 * window controls live elsewhere (TopBand), so this component is identical in
 * both surfaces.
 */
export function StatusBar() {
  const visible = useDesktopLayout((s) => s.statusBarVisible);
  const navigate = useNavigate();
  if (!visible) return null;

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
      <button
        type="button"
        onClick={() => navigate("/providers")}
        title="Open provider settings"
        className="flex items-center gap-1.5 rounded hover:bg-primary-foreground/15"
      >
        <Circle className="h-2 w-2 fill-current" />
        Local
      </button>
      <span className="opacity-70">TBAi</span>
      <button
        type="button"
        onClick={() => navigate("/providers")}
        title={statusLabel}
        className="ml-auto max-w-[55%] truncate rounded px-1 opacity-90 hover:bg-primary-foreground/15"
      >
        {statusLabel}
      </button>
      <button
        type="button"
        onClick={() => navigate("/desktop")}
        title="Desktop settings"
        className="rounded p-0.5 opacity-90 hover:bg-primary-foreground/15"
      >
        <Settings className="h-3.5 w-3.5" />
      </button>
    </footer>
  );
}
