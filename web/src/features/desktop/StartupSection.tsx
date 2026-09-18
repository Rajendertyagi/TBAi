import { useCallback, useEffect, useRef, useState } from "react";
import { Power } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection, SettingRow } from "../../components/shared/settings";
import { Switch } from "../../components/ui/switch";
import {
  isTauri,
  isAutostartEnabled,
  setAutostartEnabled,
} from "../../lib/platform";

/**
 * OS autostart switch ("Start TBAi with Windows").
 *
 * The OS registration (official Tauri autostart plugin) is the single source
 * of truth: the switch initializes from `isEnabled()`, and every toggle
 * re-reads the OS state afterwards so the UI can never disagree with it.
 * Failures surface through the app toast and leave the switch showing the
 * actual OS state. Rendered only inside the Tauri shell.
 */
export function StartupSection() {
  const [supported] = useState(() => isTauri());
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!supported) return;
    isAutostartEnabled()
      .then((on) => {
        if (!mounted.current) return;
        setEnabled(on);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        setLoadError(
          err instanceof Error ? err.message : "Could not read startup state.",
        );
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [supported]);

  const refreshActual = useCallback(async (): Promise<boolean | null> => {
    try {
      return await isAutostartEnabled();
    } catch {
      return null;
    }
  }, []);

  const onToggle = useCallback(
    async (next: boolean) => {
      if (pending || loading) return;
      setPending(true);
      try {
        await setAutostartEnabled(next);
      } catch (err: unknown) {
        toast.error(
          err instanceof Error
            ? `Could not change startup setting: ${err.message}`
            : "Could not change startup setting.",
        );
      }
      const actual = await refreshActual();
      if (!mounted.current) return;
      if (actual == null) {
        toast.error("Could not confirm startup state.");
      } else {
        setEnabled(actual);
        if (actual !== next) {
          toast.error(
            next
              ? "Startup was not enabled. OS registration unchanged."
              : "Startup was not disabled. OS registration unchanged.",
          );
        }
      }
      setPending(false);
    },
    [pending, loading, refreshActual],
  );

  if (!supported) return null;

  return (
    <SettingsSection
      title="Startup"
      icon={Power}
      description="Launch TBAi automatically when Windows starts. The switch always reflects the real OS registration."
    >
      <SettingRow
        label="Start TBAi with Windows"
        icon={Power}
        description={
          loadError ??
          "Register TBAi to start automatically with Windows sign-in."
        }
        control={
          <Switch
            checked={enabled}
            disabled={loading || pending || loadError != null}
            onCheckedChange={onToggle}
            aria-label="Start TBAi with Windows"
          />
        }
      />
    </SettingsSection>
  );
}
