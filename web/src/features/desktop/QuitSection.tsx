import { useState } from "react";
import { Power } from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  SettingsError,
  SettingsSection,
  SettingRow,
} from "../../components/shared/settings";
import { Button } from "../../components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";

/**
 * Application quit (desktop shell only).
 *
 * Invokes the backend `quit_app` command, which stops the owned Bun sidecar
 * and then ends the Tauri process itself. App-registered commands are allowed
 * by default, so no capability change is needed. Hidden entirely outside the
 * Tauri shell (`isTauri()`), where there is no desktop process to quit —
 * quitting the browser tab is the browser's own job.
 */
export function QuitSection() {
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!isTauri()) return null;

  const quit = async () => {
    setFailed(null);
    try {
      await invoke("quit_app");
      // Success ends the process; there is no post-quit UI to render.
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "Quit request failed");
    }
  };

  return (
    <SettingsSection
      title="Application"
      icon={Power}
      description="Stop the server and close the desktop app."
    >
      <SettingRow
        label="Quit TBAi"
        description="Stops the backend server and closes the app window."
        control={
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            Quit
          </Button>
        }
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quit TBAi?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the backend server and closes the desktop app. Any
              running AI work is cancelled.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void quit()}>
              Quit TBAi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {failed && <SettingsError>{failed}</SettingsError>}
    </SettingsSection>
  );
}
