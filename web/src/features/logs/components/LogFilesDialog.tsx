import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Download, FileText, HardDrive, RefreshCw, X } from "lucide-react";
import type { LogFileInfo, RetentionInfo } from "../types";

export interface LogFilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  retentionInfo: RetentionInfo | null;
  logFiles: LogFileInfo[];
  isLoading: boolean;
  onRefresh: () => void;
  onDownloadFile: (file: LogFileInfo) => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export function LogFilesDialog({
  open,
  onOpenChange,
  retentionInfo,
  logFiles,
  isLoading,
  onRefresh,
  onDownloadFile,
}: LogFilesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-5">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-primary" />
            <DialogTitle className="text-sm font-semibold text-foreground">
              Disk Log Files & Retention
            </DialogTitle>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label="Refresh log files"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </button>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close dialog"
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </DialogClose>
          </div>
        </div>

        <div className="py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Retention Stats */}
          {retentionInfo && (
            <div className="grid grid-cols-3 gap-2 p-2.5 rounded-md bg-muted/40 border border-border/50 text-xs">
              <div>
                <span className="text-3xs text-muted-foreground block">Total Disk Files</span>
                <span className="font-semibold text-foreground">{retentionInfo.fileCount}</span>
              </div>
              <div>
                <span className="text-3xs text-muted-foreground block">Total Size</span>
                <span className="font-semibold text-foreground">
                  {formatBytes(retentionInfo.totalBytes)}
                </span>
              </div>
              <div>
                <span className="text-3xs text-muted-foreground block">Max Cap</span>
                <span className="font-semibold text-foreground">{retentionInfo.maxTotalMb} MB</span>
              </div>
            </div>
          )}

          {/* File List */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Rotated Log Files</span>
            {logFiles.length === 0 ? (
              <p className="text-3xs text-muted-foreground/60 italic py-3 text-center border border-dashed border-border rounded-md">
                No log files found on disk.
              </p>
            ) : (
              <div className="space-y-1 font-mono text-2xs">
                {logFiles.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center justify-between p-2 rounded-md bg-muted/20 hover:bg-muted/40 border border-border/30 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <div className="truncate">
                        <span className="font-medium text-foreground">{file.name}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-muted-foreground text-3xs">
                        {formatBytes(file.size_bytes)}
                      </span>
                      <button
                        type="button"
                        onClick={() => onDownloadFile(file)}
                        title={`Download ${file.name}`}
                        aria-label={`Download ${file.name}`}
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
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
