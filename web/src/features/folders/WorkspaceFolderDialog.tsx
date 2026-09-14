import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DirectoryBrowser } from "@/components/shared/directory-browser";
import { FolderLinksManager } from "./FolderLinksManager";
import { useFoldersStore } from "@/stores/foldersStore";
import type { Folder } from "@/types";

type View = "root" | "links";

/**
 * Add / register a workspace folder (codeg-aligned 3-step flow, condensed to two
 * views here): pick the root directory, then manage linked/allowed paths. In
 * manage mode (`folder` prop) it opens directly on the links view of an existing
 * folder. Registration upserts the folder row; the folder ID is the canonical
 * identity and its path is resolved server-side thereafter.
 */
export function WorkspaceFolderDialog({
  open,
  onOpenChange,
  folder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder?: Folder | null;
}) {
  const createFolder = useFoldersStore((s) => s.createFolder);
  const [view, setView] = useState<View>("root");
  const [selectedPath, setSelectedPath] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (folder) {
      setView("links");
      setFolderId(folder.id);
    } else {
      setView("root");
      setFolderId(null);
      setSelectedPath("");
    }
  }, [open, folder]);

  const handleRootSelect = async (path: string) => {
    setSelectedPath(path);
    setBusy(true);
    try {
      const created = await createFolder({ path });
      setFolderId(created?.id ?? null);
      setView("links");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {folder ? "Manage folder" : "Add workspace folder"}
          </DialogTitle>
          <DialogDescription>
            {view === "root"
              ? "Choose the project directory to register. Its path is resolved server-side; conversations attach by folder id, never by raw path."
              : "Optionally link other directories this folder may operate in (authorization records)."}
          </DialogDescription>
        </DialogHeader>

        {view === "root" ? (
          <DirectoryBrowser initialPath={selectedPath} onSelect={handleRootSelect} />
        ) : (
          folderId && <FolderLinksManager folderId={folderId} />
        )}

        <DialogFooter>
          {view === "links" && (
            <Button onClick={() => onOpenChange(false)} disabled={busy}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
