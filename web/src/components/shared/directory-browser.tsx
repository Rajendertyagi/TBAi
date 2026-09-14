import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen, CornerDownLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: string[];
}

/**
 * Server-backed directory browser for picking an arbitrary local folder during
 * registration. Uses the dedicated `/api/folders/browse` endpoint (which lists
 * directories only — never file contents), distinct from the workspace-confined
 * file tools. Adapted from codeg's `shared/directory-browser` flow.
 */
export function DirectoryBrowser({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel?: () => void;
}) {
  const [path, setPath] = useState(initialPath ?? "");
  const [input, setInput] = useState(initialPath ?? "");
  const [entries, setEntries] = useState<string[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const browse = (target: string) => {
    setLoading(true);
    setError(null);
    const url = `/api/folders/browse?path=${encodeURIComponent(target)}`;
    fetch(url)
      .then(async (res) => {
        const data = (await res.json()) as BrowseResult & { error?: string };
        if (!res.ok) throw new Error(data.error || "Browse failed");
        setPath(data.path);
        setInput(data.path);
        setEntries(data.entries);
        setParent(data.parent);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Browse failed"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    browse(path || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const segments = path.split(/[\\/]/).filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight aria-hidden="true" className="size-3" />}
            <button
              type="button"
              className="rounded px-1 hover:bg-muted hover:text-foreground"
              onClick={() =>
                browse(segments.slice(0, i + 1).join("/"))
              }
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <div className="flex gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") browse(input.trim());
          }}
          placeholder="Path to a folder"
          aria-label="Folder path"
        />
        <Button variant="outline" size="sm" onClick={() => browse(input.trim())} disabled={loading}>
          Go
        </Button>
      </div>

      {parent && (
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-left text-sm hover:bg-muted"
          onClick={() => parent && browse(parent)}
        >
          <FolderOpen aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">.. (up one level)</span>
        </button>
      )}

      <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
        {entries.length === 0 && !loading && (
          <p className="px-2 py-1 text-xs text-muted-foreground">No subfolders</p>
        )}
        {entries.map((name) => {
          const child = `${path.replace(/[\\/]$/, "")}/${name}`;
          return (
            <button
              key={name}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
              onClick={() => browse(child)}
            >
              <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </button>
          );
        })}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={() => onSelect(path)} disabled={!path}>
          <CornerDownLeft aria-hidden="true" className="size-4" />
          Select this folder
        </Button>
      </div>
    </div>
  );
}
