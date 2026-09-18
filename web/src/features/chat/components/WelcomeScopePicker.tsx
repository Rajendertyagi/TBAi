import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useAuiState } from "@assistant-ui/react";
import { Check, ChevronDown, Folder, MessageSquare } from "lucide-react";
import { welcomeConfig } from "@/config/welcome";
import { useWelcomeScopeStore } from "@/features/chat/state/welcomeScope";
import { useFoldersStore } from "@/stores/foldersStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

/**
 * Codeg parity folder scope chip (composer-attached row).
 * Editable (drafts): compact trigger opens a searchable popover; folderless
 * "chat mode" is the pinned sticky footer entry. Static (bound threads):
 * bare chip showing the conversation's workspace, never a trigger —
 * folder switch always means a new draft.
 */
export function WelcomeScopePicker({ editable = true }: { editable?: boolean }) {
  const copy = welcomeConfig.copy;
  const navigate = useNavigate();
  const scope = useWelcomeScopeStore((s) => s.scope);
  const setScope = useWelcomeScopeStore((s) => s.setScope);
  const validate = useWelcomeScopeStore((s) => s.validateAgainstFolderIds);
  const folders = useFoldersStore((s) => s.folders);
  const foldersLoaded = useFoldersStore((s) => s.foldersLoaded);
  const loadFolders = useFoldersStore((s) => s.loadFolders);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  // Prune a preset/dead folder id only against a loaded list. An empty list
  // before the first load means "unknown" — validating against it wiped a
  // just-preset folder scope (e.g. folder "+" → draft) back to Chat mode.
  useEffect(() => {
    if (foldersLoaded) validate(folders.map((f) => f.id));
  }, [folders, foldersLoaded, validate]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open ]);

  const visibleFolders = useMemo(() => {
    const base = folders.filter((f) => f.kind !== "chat");
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((f) =>
      `${f.alias ?? ""} ${f.name} ${f.path}`.toLowerCase().includes(q),
    );
  }, [folders, query]);

  const boundCustom = useAuiState((s) => s.threadListItem.custom) as
    | { workspaceMode?: "simple" | "project"; workspaceFolderId?: string | null }
    | undefined;

  if (!editable) {
    const boundMode = boundCustom?.workspaceMode ?? "simple";
    const boundFolderId = boundCustom?.workspaceFolderId ?? null;
    const boundFolder =
      boundMode === "project" && boundFolderId
        ? (folders.find((f) => f.id === boundFolderId) ?? null)
        : null;
    const boundName =
      boundMode === "simple"
        ? copy.chatModeLabel
        : (boundFolder?.alias || boundFolder?.name || copy.folderRemoved);
    return (
      <div className="flex justify-start">
        <Button
          variant="ghost"
          size="xs"
          type="button"
          title={`${copy.folderTitle}: ${boundName}`}
          aria-label={`${copy.folderTitle}: ${boundName}`}
          className={cn(
            "min-w-0 cursor-default gap-0.5 px-1.5 opacity-60 hover:bg-transparent",
          )}
          onClick={(e) => e.preventDefault()}
        >
          <Folder aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          <span className="max-w-[8.75rem] truncate">{boundName}</span>
        </Button>
      </div>
    );
  }

  const current = folders.find((f) => f.id === scope.folderId) ?? null;
  const isChatMode = scope.mode === "simple";
  const currentName = isChatMode
    ? copy.chatModeLabel
    : (current?.alias || current?.name || copy.scopeLabel);

  return (
    <div className="flex justify-start">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            type="button"
            title={`${copy.folderTitle}: ${currentName}`}
            aria-label={`${copy.folderTitle}: ${currentName}`}
            className={cn("min-w-0 gap-0.5 px-1.5")}
          >
            <Folder aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            <span className="max-w-[8.75rem] truncate">{currentName}</span>
            <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72 overflow-hidden rounded-2xl p-0">
          <div className="p-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={copy.searchFolder}
              aria-label={copy.searchFolder}
              className="h-8"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {visibleFolders.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {query.trim() ? copy.noFolders : copy.noFoldersHint}
              </p>
            ) : (
              visibleFolders.map((f) => {
                const label = f.alias || f.name;
                const active = scope.mode === "project" && scope.folderId === f.id;
                return (
                  <DropdownMenuItem
                    key={f.id}
                    onSelect={() => {
                      setScope({ mode: "project", folderId: f.id });
                      setOpen(false);
                    }}
                    className={cn(active && "bg-accent text-accent-foreground")}
                  >
                    <Folder aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {f.path}
                        {typeof f.conversationCount === "number" &&
                          ` · ${copy.folderConversations(f.conversationCount)}`}
                      </span>
                    </span>
                    {active && <Check aria-hidden="true" className="h-4 w-4 shrink-0" />}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
          <div className="sticky bottom-0 bg-popover">
            <DropdownMenuSeparator />
            <div className="p-1">
              <DropdownMenuItem
                onSelect={() => {
                  setScope({ mode: "simple", folderId: null });
                  setOpen(false);
                }}
                className={cn(isChatMode && "bg-accent text-accent-foreground")}
              >
                <MessageSquare aria-hidden="true" className="size-4 shrink-0" />
                <span className="flex-1 truncate text-sm font-medium">
                  {copy.chatModeLabel}
                </span>
                {isChatMode && <Check aria-hidden="true" className="size-4 shrink-0" />}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setOpen(false);
                  navigate("/folders");
                }}
              >
                <span className="text-xs text-muted-foreground">{copy.manageFolders}</span>
              </DropdownMenuItem>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
