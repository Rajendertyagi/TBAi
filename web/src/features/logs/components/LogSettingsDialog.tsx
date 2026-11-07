import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Plus, Sliders, Trash2, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { CaptureLevel, FileSettings, ScopeTarget } from "../types";

export interface LogSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  captureLevel: CaptureLevel;
  onCaptureLevelChange: (level: CaptureLevel) => void;
  fileSettings?: FileSettings;
  onFileSettingsChange?: (settings: Partial<FileSettings>) => void;
  scopes: ScopeTarget[];
  onScopesChange: (scopes: ScopeTarget[]) => void;
  availableScopes?: string[];
}

const CAPTURE_LEVELS: CaptureLevel[] = ["off", "error", "warn", "info", "debug"];

export function LogSettingsDialog({
  open,
  onOpenChange,
  captureLevel,
  onCaptureLevelChange,
  fileSettings,
  onFileSettingsChange,
  scopes,
  onScopesChange,
  availableScopes = [],
}: LogSettingsDialogProps) {
  const [newScope, setNewScope] = useState("");
  const [newLevel, setNewLevel] = useState<CaptureLevel>("debug");

  const handleAddScope = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newScope.trim();
    if (!trimmed) return;
    if (scopes.some((s) => s.scope === trimmed)) return;
    onScopesChange([...scopes, { scope: trimmed, level: newLevel }]);
    setNewScope("");
  };

  const handleRemoveScope = (scopeToRemove: string) => {
    onScopesChange(scopes.filter((s) => s.scope !== scopeToRemove));
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
              className="w-full h-8 px-2 rounded-md border border-border bg-background text-xs font-mono text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
            >
              {CAPTURE_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          {/* File Sink */}
          {fileSettings && onFileSettingsChange && (
            <div className="pt-2 border-t border-border/60 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-foreground">Disk File Sink</span>
                  <p className="text-3xs text-muted-foreground">
                    Write formatted log entries to disk files with automatic rotation.
                  </p>
                </div>
                <Switch
                  checked={fileSettings.enabled}
                  onCheckedChange={(checked: boolean) => onFileSettingsChange({ enabled: checked })}
                />
              </div>
            </div>
          )}

          {/* Per-Scope Overrides */}
          <div className="pt-2 border-t border-border/60 space-y-2">
            <div>
              <span className="text-xs font-medium text-foreground">Per-Scope Overrides</span>
              <p className="text-3xs text-muted-foreground">
                Override capture levels for specific components or subsystems.
              </p>
            </div>

            {/* Add Override Form */}
            <form onSubmit={handleAddScope} className="flex gap-2">
              <input
                type="text"
                placeholder="Scope name..."
                value={newScope}
                onChange={(e) => setNewScope(e.target.value)}
                list="scope-datalist"
                className="flex-1 h-8 px-2 rounded-md border border-border bg-background text-xs font-mono text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              />
              <datalist id="scope-datalist">
                {availableScopes.map((sc) => (
                  <option key={sc} value={sc} />
                ))}
              </datalist>

              <select
                value={newLevel}
                onChange={(e) => setNewLevel(e.target.value as CaptureLevel)}
                className="w-24 h-8 px-2 rounded-md border border-border bg-background text-xs font-mono text-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
              >
                {CAPTURE_LEVELS.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl.toUpperCase()}
                  </option>
                ))}
              </select>

              <button
                type="submit"
                disabled={!newScope.trim()}
                className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </form>

            {/* Scope Override List */}
            <div className="space-y-1.5 pt-1">
              {scopes.length === 0 ? (
                <p className="text-3xs text-muted-foreground/60 italic py-1">
                  No active scope overrides.
                </p>
              ) : (
                scopes.map((s) => (
                  <div
                    key={s.scope}
                    className="flex items-center justify-between p-2 rounded-md bg-muted/30 border border-border/40 font-mono text-xs"
                  >
                    <span className="text-primary font-medium">{s.scope}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-3xs uppercase font-semibold text-muted-foreground">
                        {s.level}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveScope(s.scope)}
                        aria-label={`Remove override for ${s.scope}`}
                        className="p-1 rounded text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
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
