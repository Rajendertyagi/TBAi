import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FolderOpen, FolderPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EnginePicker } from "@/components/EnginePicker";
import { useFoldersStore } from "@/stores/foldersStore";
import { createConversation } from "@/adapters/remoteThreadListAdapter";
import { threadUrl } from "@/features/chat/state/chatTabs";
import type { WelcomeEngine } from "@/features/chat/state/welcomeEngine";

/**
 * "New Project Chat" picker. Lets the user choose a registered folder before
 * creating the conversation; the conversation is attached to that folder
 * (workspace_mode = 'project', workspace_folder_id = folder id) and the
 * attachment persists across reloads. Does NOT touch the global active folder.
 */
export function NewProjectChatDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const folders = useFoldersStore((s) => s.folders);
  const loadFolders = useFoldersStore((s) => s.loadFolders);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engine, setEngine] = useState<WelcomeEngine>("direct");
  const [busy, setBusy] = useState(false);
  // Truthful creation failure (e.g. the selected folder was unregistered
  // between list and click): the dialog stays open with the server's message
  // instead of rejecting into an unhandled promise.
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedId(null);
      setEngine("direct");
      setCreateError(null);
      void loadFolders();
    }
  }, [open, loadFolders]);

  const handleCreate = async () => {
    if (!selectedId) return;
    setBusy(true);
    setCreateError(null);
    try {
      const { id } = await createConversation({
        workspaceMode: "project",
        workspaceFolderId: selectedId,
        engine,
        title: "New Project Chat",
      });
      onOpenChange(false);
      navigate(threadUrl(id, engine));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Project Chat</DialogTitle>
          <DialogDescription>
            Choose a registered folder. The chat will be attached to it and use
            that folder as its workspace.
          </DialogDescription>
        </DialogHeader>

        {folders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No folders registered yet. Add one in Settings → Folders.
          </p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {folders.map((f) => {
              const label = f.alias || f.name;
              const active = selectedId === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedId(f.id)}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${
                    active
                      ? "border-ring bg-accent text-accent-foreground"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {f.path}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {createError && (
          <p role="alert" className="text-xs text-destructive">
            {createError}
          </p>
        )}

        <DialogFooter className="flex-col gap-3 sm:flex-col">
          <EnginePicker value={engine} onChange={setEngine} />
          <div className="flex w-full justify-between gap-2">          <Button
            variant="outline"
            onClick={() => navigate("/folders")}
            type="button"
          >
            <FolderPlus aria-hidden="true" className="size-4" />
            Manage folders
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!selectedId || busy}
            type="button"
          >
            Start chat
          </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
