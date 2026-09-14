import { useEffect, useState } from "react";
import { Link2, Link2Off, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFoldersStore } from "@/stores/foldersStore";
import { DirectoryBrowser } from "@/components/shared/directory-browser";
import type { FolderLink } from "@/types";

/**
 * Linked/allowed paths for a registered folder (authorization records — phase 1,
 * no real symlinks). Mirrors codeg's folder-link UX: list with status, add a
 * target directory, rename, remove. The target is resolved at use time, so a
 * moved/removed directory surfaces as a broken record rather than silently
 * resolving elsewhere.
 */
export function FolderLinksManager({ folderId }: { folderId: string }) {
  const listLinks = useFoldersStore((s) => s.listLinks);
  const registerLink = useFoldersStore((s) => s.registerLink);
  const renameLink = useFoldersStore((s) => s.renameLink);
  const deleteLink = useFoldersStore((s) => s.deleteLink);
  const [links, setLinks] = useState<FolderLink[]>([]);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => listLinks(folderId).then(setLinks).catch(() => {});

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const handleAdd = async () => {
    if (!target.trim() || !name.trim()) return;
    setBusy(true);
    try {
      await registerLink(folderId, name.trim(), target.trim());
      setTarget("");
      setName("");
      setAdding(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Linked / allowed paths
        </span>
        {!adding && (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" className="size-3.5" />
            Add path
          </Button>
        )}
      </div>

      {links.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">
          No linked paths. Add directories the assistant may also operate in.
        </p>
      )}

      <div className="space-y-1">
        {links.map((l) => (
          <div
            key={l.id}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
          >
            <Link2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{l.name}</div>
              <div className="truncate text-xs text-muted-foreground">{l.targetPath}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = window.prompt("Rename link", l.name);
                if (next && next.trim()) void renameLink(folderId, l.id, next.trim()).then(refresh);
              }}
              title="Rename"
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void deleteLink(folderId, l.id).then(refresh)}
              title="Remove"
            >
              <Link2Off aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="space-y-2 rounded-md border border-border p-2">
          <DirectoryBrowser
            initialPath={target}
            onSelect={(p) => {
              setTarget(p);
              if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? "");
            }}
            onCancel={() => setAdding(false)}
          />
          <div className="flex items-center gap-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Link name"
              aria-label="Link name"
            />
            <Button size="sm" onClick={handleAdd} disabled={busy || !target || !name}>
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
