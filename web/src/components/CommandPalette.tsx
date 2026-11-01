import { useEffect, useRef, useState, useMemo } from "react";
import { Search, Folder, Settings, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useDesktopLayout } from "@/features/desktop/state/desktopLayout";
import { useFoldersStore } from "@/features/folders/state/foldersStore";
import { useConversationsList } from "@/features/sidebar/hooks/useConversationsList";
import { useNavigate } from "react-router";
import { ROUTES } from "@/config/navigation";
import { threadUrl } from "@/features/chat/state/chatTabs";
import { ENGINES } from "@/config/engines";
import { cn } from "@/lib/utils";

interface ActionItem {
  id: string;
  kind: "action";
  label: string;
  subtitle: string;
  icon: typeof Plus;
  run: () => void;
}

interface FolderResultItem {
  id: string;
  kind: "folder";
  label: string;
  subtitle: string;
  color: string;
  run: () => void;
}

interface ChatResultItem {
  id: string;
  kind: "chat";
  label: string;
  subtitle: string;
  engine: "direct" | "opencode";
  run: () => void;
}

type PaletteItem = ActionItem | FolderResultItem | ChatResultItem;

/**
 * Paseo-style Command Center popout palette (P15).
 * 640px × 560px modal panel, top-anchored (top-12), Radix Dialog, combobox/listbox keyboard navigation.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const searchOpen = useDesktopLayout((s) => s.searchOpen);
  const setSearchOpen = useDesktopLayout((s) => s.setSearchOpen);
  const searchInput = useDesktopLayout((s) => s.searchInput);
  const setSearchInput = useDesktopLayout((s) => s.setSearchInput);
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const folders = useFoldersStore((s) => s.folders);

  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { items: serverChats } = useConversationsList({
    search: searchQuery,
    limit: 20,
    enabled: searchOpen,
  });

  // Actions
  const actions: ActionItem[] = useMemo(
    () => [
      {
        id: "act_new_chat",
        kind: "action",
        label: "New Chat",
        subtitle: "Start a new simple conversation",
        icon: Plus,
        run: () => {
          setSearchOpen(false);
          navigate(ROUTES.CHAT_NEW);
        },
      },
      {
        id: "act_settings",
        kind: "action",
        label: "Settings",
        subtitle: "Open application preferences",
        icon: Settings,
        run: () => {
          setSearchOpen(false);
          navigate(ROUTES.SETTINGS.PROVIDERS);
        },
      },
    ],
    [navigate, setSearchOpen],
  );

  // Filtered folders
  const matchedFolders: FolderResultItem[] = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    const list = q
      ? folders.filter(
          (f) => (f.alias || f.name).toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
        )
      : folders.slice(0, 5);

    return list.map((f) => ({
      id: `folder_${f.id}`,
      kind: "folder",
      label: f.alias || f.name,
      subtitle: f.path,
      color: f.color,
      run: () => {
        setSearchOpen(false);
        navigate(ROUTES.FOLDERS);
      },
    }));
  }, [folders, searchQuery, navigate, setSearchOpen]);

  // Chat results
  const chatResults: ChatResultItem[] = useMemo(() => {
    return serverChats.map((c) => {
      const engineKey = c.engine === "opencode" ? "opencode" : "direct";
      return {
        id: `chat_${c.remoteId}`,
        kind: "chat",
        label: c.title || "Untitled",
        subtitle: engineKey === "opencode" ? "Code agent" : "Direct chat",
        engine: engineKey,
        run: () => {
          setSearchOpen(false);
          navigate(threadUrl(c.remoteId, c.engine));
        },
      };
    });
  }, [serverChats, navigate, setSearchOpen]);

  // Flattened items list
  const allItems: PaletteItem[] = useMemo(() => {
    return [...actions, ...matchedFolders, ...chatResults];
  }, [actions, matchedFolders, chatResults]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection on query change
  useEffect(() => {
    setActiveIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (allItems.length > 0 ? (prev + 1) % allItems.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) =>
        allItems.length > 0 ? (prev - 1 + allItems.length) % allItems.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (allItems[activeIndex]) {
        allItems[activeIndex].run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setSearchOpen(false);
    }
  };

  return (
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
      <DialogContent
        className="fixed top-12 left-1/2 -translate-x-1/2 translate-y-0 w-[640px] max-w-[92vw] h-[560px] max-h-[80vh] p-0 rounded-lg border border-border bg-popover shadow-overlay overflow-hidden flex flex-col"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Command Center</DialogTitle>

        {/* Header Search Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search conversations, folders, actions…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Results Listbox */}
        <div role="listbox" className="flex-1 overflow-y-auto p-2 space-y-4">
          {actions.length > 0 && (
            <div>
              <div className="px-2 py-1 text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
                Actions
              </div>
              <div className="space-y-0.5">
                {actions.map((act) => {
                  const globalIdx = allItems.findIndex((it) => it.id === act.id);
                  const isSelected = globalIdx === activeIndex;
                  const Icon = act.icon;
                  return (
                    <button
                      key={act.id}
                      type="button"
                      onClick={act.run}
                      onMouseEnter={() => setActiveIndex(globalIdx)}
                      className={cn(
                        "w-full text-left flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors text-sm outline-none",
                        isSelected
                          ? "bg-[var(--sidebar-row-active)] text-foreground"
                          : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-foreground">{act.label}</div>
                        <div className="text-2xs text-muted-foreground truncate">
                          {act.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {matchedFolders.length > 0 && (
            <div>
              <div className="px-2 py-1 text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
                Folders
              </div>
              <div className="space-y-0.5">
                {matchedFolders.map((f) => {
                  const globalIdx = allItems.findIndex((it) => it.id === f.id);
                  const isSelected = globalIdx === activeIndex;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={f.run}
                      onMouseEnter={() => setActiveIndex(globalIdx)}
                      className={cn(
                        "w-full text-left flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors text-sm outline-none",
                        isSelected
                          ? "bg-[var(--sidebar-row-active)] text-foreground"
                          : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-foreground">{f.label}</div>
                        <div className="text-2xs text-muted-foreground font-mono truncate">
                          {f.subtitle}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {chatResults.length > 0 && (
            <div>
              <div className="px-2 py-1 text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
                Conversations
              </div>
              <div className="space-y-0.5">
                {chatResults.map((c) => {
                  const globalIdx = allItems.findIndex((it) => it.id === c.id);
                  const isSelected = globalIdx === activeIndex;
                  const visual = ENGINES[c.engine];
                  const Icon = visual.icon;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={c.run}
                      onMouseEnter={() => setActiveIndex(globalIdx)}
                      className={cn(
                        "w-full text-left flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors text-sm outline-none",
                        isSelected
                          ? "bg-[var(--sidebar-row-active)] text-foreground"
                          : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      <Icon aria-hidden className={cn("size-4 shrink-0", visual.badgeClass)} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-foreground truncate">{c.label}</div>
                        <div className="text-2xs text-muted-foreground">{c.subtitle}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {allItems.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No results found for &ldquo;{searchQuery}&rdquo;
            </div>
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="px-4 py-2 border-t border-border bg-muted/20 flex items-center justify-between text-2xs text-muted-foreground">
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
