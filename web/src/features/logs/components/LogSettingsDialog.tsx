import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Plus, Sliders, Trash2, X } from "lucide-react";
import type { CaptureLevel, FileSettings, ScopeTarget } from "../types";

export interface LogSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  captureLevel: CaptureLevel;
  onCaptureLevelChange: (level: CaptureLevel) => void;
  envLocked: boolean;
  fileSettings: FileSettings | null;
  fileLocked: boolean;
  onFileSettingsChange: (patch: Partial<FileSettings>) => void;
  targets: ScopeTarget[];
  onTargetsChange: (targets: ScopeTarget[]) => void;
  onSave: () => void;
}

const CAPTURE_LEVELS: CaptureLevel[] = ["off", "error", "warn", "info", "debug"];

// Scope paths are dot-separated idents; an override matches its scope and
// everything below it. Rows failing this are flagged and excluded from saves.
const SCOPE_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

const CURATED_SCOPES = [
  "http",
  "chat",
  "ai.provider",
  "mcp",
  "tools",
  "storage",
  "server",
  "scheduler",
  "memory",
  "workspace",
  "conversations",
];

export function LogSettingsDialog({
  open,
  onOpenChange,
  captureLevel,
  onCaptureLevelChange,
  envLocked,
  fileSettings,
  fileLocked,
  onFileSettingsChange,
  targets,
  onTargetsChange,
  onSave,
}: LogSettingsDialogProps) {
  const handleAddTarget = () => {
    // Local-only blank row; persisted once it holds a valid scope (on blur/save).
    onTargetsChange([...targets, { scope: "", level: "debug" }]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-primary" />
            <DialogTitle className="text-sm font-semibold text-foreground">
              Log Runtime Settings
            </DialogTitle>
          </div>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close settings dialog"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </DialogClose>
        </div>

        <div className="py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Global Capture Level */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Default Capture Level</span>
            <p className="text-3xs text-muted-foreground">
              Controls the minimum severity emitted to the in-memory buffer and UI.
            </p>
            <select
              value={captureLevel}
              onChange={(e) => onCaptureLevelChange(e.target.value as CaptureLevel)}
              disabled={envLocked}
              className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs font-mono text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
            >
              {CAPTURE_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl.toUpperCase()}
                </option>
              ))}
            </select>
            {envLocked && (
              <p className="text-2xs text-amber-500">
                Controlled by TBAI_LOG_LEVEL — unset it to manage levels here.
              </p>
            )}
          </div>

          {/* File Sink */}
          <div className="pt-2 border-t border-border/60 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-medium text-foreground">Disk File Sink</span>
                <p className="text-3xs text-muted-foreground">
                  Write formatted log entries to disk files with automatic rotation.
                </p>
              </div>
              <Switch
                checked={fileSettings?.enabled ?? false}
                onCheckedChange={(checked: boolean) => onFileSettingsChange({ enabled: checked })}
                disabled={fileLocked || fileSettings === null}
                aria-label="Toggle file sink"
              />
            </div>
            {fileLocked && (
              <p className="text-2xs text-amber-500">
                Controlled by TBAI_LOG_FILE — unset it to manage the sink here.
              </p>
            )}
          </div>

          {/* Per-Scope Overrides */}
          <div className="pt-2 border-t border-border/60 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <span className="text-xs font-medium text-foreground">Per-Scope Overrides</span>
                <p className="text-3xs text-muted-foreground">
                  Override capture levels for specific components or subsystems. An override matches
                  its scope and everything below it.
                </p>
              </div>
              <button
                type="button"
                onClick={handleAddTarget}
                disabled={envLocked}
                className="h-7 px-2 rounded-md border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted text-xs font-medium flex items-center gap-1 transition-colors disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>

            {targets.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {targets.map((row, i) => {
                  const trimmed = row.scope.trim();
                  const invalid = trimmed !== "" && !SCOPE_RE.test(trimmed);
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: editable rows - index is the identity of the row being typed into; re-keying on value changes would destroy focus/caret.
                      key={i}
                      className="flex items-center gap-2"
                    >
                      <input
                        type="text"
                        value={row.scope}
                        onChange={(e) =>
                          onTargetsChange(
                            targets.map((r, j) => (j === i ? { ...r, scope: e.target.value } : r)),
                          )
                        }
                        onBlur={onSave}
                        placeholder="mcp"
                        list="tbai-log-scopes"
                        disabled={envLocked}
                        className={`flex-1 h-8 px-2 rounded-md border bg-background text-xs font-mono text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 disabled:opacity-50 ${
                          invalid ? "border-red-500/60" : "border-border"
                        }`}
                      />
                      <select
                        value={row.level}
                        onChange={(e) => {
                          onTargetsChange(
                            targets.map((r, j) =>
                              j === i ? { ...r, level: e.target.value as CaptureLevel } : r,
                            ),
                          );
                          onSave();
                        }}
                        disabled={envLocked}
                        className="w-24 h-8 px-2 rounded-md border border-border bg-background text-xs font-mono text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50"
                      >
                        {CAPTURE_LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl.toUpperCase()}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          onTargetsChange(targets.filter((_, j) => j !== i));
                          onSave();
                        }}
                        disabled={envLocked}
                        aria-label="Remove override"
                        className="p-1.5 rounded text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
                <datalist id="tbai-log-scopes">
                  {CURATED_SCOPES.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
            )}
            {targets.length === 0 && (
              <p className="text-3xs text-muted-foreground/60 italic py-1">
                No active scope overrides.
              </p>
            )}
          </div>
        </div>

        <div className="pt-3 border-t border-border flex justify-end">
          <DialogClose asChild>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
            >
              Close
            </button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
