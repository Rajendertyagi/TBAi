"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  Clock,
  Download,
  Folder,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelativeTime } from "@/lib/date-format";
import { ROUTES } from "@/config/navigation";
import { useChatTabsStore } from "@/features/chat/state/chatTabs";
import {
  fetchImportableSessions,
  importOpenCodeSession,
  type ImportableSessionSummary,
} from "./opencodeImportApi";

interface OpenCodeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Truncates directory paths in the middle to fit compactly while preserving
 * both the root/drive prefix and project basename.
 */
function truncateMiddle(str: string, maxLen = 34): string {
  if (!str || str.length <= maxLen) return str;
  const partLen = Math.floor((maxLen - 3) / 2);
  return `${str.slice(0, partLen)}...${str.slice(-partLen)}`;
}

export function OpenCodeImportDialog({ open, onOpenChange }: OpenCodeImportDialogProps) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<ImportableSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [importingId, setImportingId] = useState<string | null>(null);

  // Specific inline banners for server outcomes
  const [duplicateConflict, setDuplicateConflict] = useState<{
    sessionId: string;
    conversationId: string;
    message: string;
  } | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  const loadSessions = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    setDuplicateConflict(null);
    setStaleNotice(null);

    try {
      const result = await fetchImportableSessions({
        limit: 30,
        includeChildren: true,
      });
      setSessions(result.sessions);
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load OpenCode sessions");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadMoreSessions = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchImportableSessions({
        cursor: nextCursor,
        limit: 30,
        includeChildren: true,
      });
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.sessionId));
        const newItems = result.sessions.filter((s) => !existingIds.has(s.sessionId));
        return [...prev, ...newItems];
      });
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more sessions");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useEffect(() => {
    if (open) {
      setSearchFilter("");
      setImportingId(null);
      void loadSessions(false);
    }
  }, [open, loadSessions]);

  const handleImport = async (session: ImportableSessionSummary) => {
    setImportingId(session.sessionId);
    setDuplicateConflict(null);
    setStaleNotice(null);
    setError(null);

    try {
      const result = await importOpenCodeSession(session.sessionId, session.sourceRef);
      if (result.ok) {
        onOpenChange(false);
        useChatTabsStore.getState().openAgent(result.conversationId);
        navigate(ROUTES.code(result.conversationId));
        return;
      }

      if (result.errorKind === "already_imported") {
        setDuplicateConflict({
          sessionId: session.sessionId,
          conversationId: result.conversationId,
          message: result.message,
        });
      } else if (result.errorKind === "stale_source") {
        setStaleNotice(result.message);
      } else if (result.errorKind === "session_not_found") {
        setError(result.message);
        void loadSessions(true);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected import error");
    } finally {
      setImportingId(null);
    }
  };

  const openExistingConversation = (conversationId: string) => {
    onOpenChange(false);
    useChatTabsStore.getState().openAgent(conversationId);
    navigate(ROUTES.code(conversationId));
  };

  const filteredSessions = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const titleMatch = s.title?.toLowerCase().includes(q) ?? false;
      const dirMatch = s.directory.toLowerCase().includes(q);
      const idMatch = s.sessionId.toLowerCase().includes(q);
      const projectMatch = s.projectName?.toLowerCase().includes(q) ?? false;
      const branchMatch = s.gitBranch?.toLowerCase().includes(q) ?? false;
      const promptMatch = s.firstPromptPreview?.toLowerCase().includes(q) ?? false;
      return titleMatch || dirMatch || idMatch || projectMatch || branchMatch || promptMatch;
    });
  }, [sessions, searchFilter]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="shrink-0 space-y-1">
          <div className="flex items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <Download className="size-4.5 text-primary" />
              Import from OpenCode
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Attach to an existing OpenCode session. TBAi connects directly to the original session
            and streams live native history without duplicating messages.
          </DialogDescription>
        </DialogHeader>

        {/* Duplicate Conflict Banner */}
        {duplicateConflict && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs flex items-center justify-between gap-3 text-amber-200">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="size-4 shrink-0 text-amber-400" />
              <span className="truncate">{duplicateConflict.message}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openExistingConversation(duplicateConflict.conversationId)}
              className="shrink-0 h-7 text-xs border-amber-500/40 text-amber-100 hover:bg-amber-500/20"
            >
              Open Conversation
              <ArrowRight className="size-3.5 ml-1" />
            </Button>
          </div>
        )}

        {/* Stale Target / Source Notice */}
        {staleNotice && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs flex items-center justify-between gap-3 text-amber-200">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="size-4 shrink-0 text-amber-400" />
              <span className="truncate">{staleNotice}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadSessions(true)}
              className="shrink-0 h-7 text-xs border-amber-500/40 text-amber-100 hover:bg-amber-500/20"
            >
              <RefreshCw className="size-3 mr-1" />
              Refresh
            </Button>
          </div>
        )}

        {/* Error Notice */}
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs flex items-center justify-between gap-3 text-destructive">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="size-4 shrink-0" />
              <span className="truncate">{error}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadSessions(true)}
              className="shrink-0 h-7 text-xs"
            >
              Retry
            </Button>
          </div>
        )}

        {/* Search & Refresh Controls */}
        <div className="flex items-center gap-2 shrink-0 pt-1">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Filter by title, directory, or session ID..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadSessions(true)}
            disabled={loading || refreshing}
            title="Refresh session list"
            className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`size-3.5 ${refreshing || loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {/* Sessions List Area */}
        <div className="flex-1 min-h-[240px] max-h-[420px] overflow-y-auto rounded-lg border border-border/40 divide-y divide-border/20 bg-background/40">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground">
              <Loader2 className="size-5 animate-spin text-primary" />
              <span className="text-xs">Scanning available OpenCode sessions...</span>
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 px-4 text-center text-muted-foreground">
              <Folder className="size-8 text-muted-foreground/40" />
              <p className="text-xs font-medium text-foreground/80">
                {sessions.length === 0
                  ? "No importable OpenCode sessions found"
                  : "No sessions match your filter"}
              </p>
              <p className="text-2xs text-muted-foreground/70 max-w-sm">
                {sessions.length === 0
                  ? "Only active sessions from the connected OpenCode instance that have not yet been imported into TBAi appear here."
                  : "Try clearing or broadening your search query."}
              </p>
            </div>
          ) : (
            <>
              {filteredSessions.map((s) => {
                const isImporting = importingId === s.sessionId;
                const rawTitle = s.title?.trim() || "";
                const isPlaceholderTitle =
                  !rawTitle ||
                  rawTitle.toLowerCase() === "ok" ||
                  rawTitle.toLowerCase() === "new session" ||
                  rawTitle.toLowerCase() === "imported session";

                let displayTitle = rawTitle || "Untitled Session";
                let showPromptAsTitle = false;

                if (isPlaceholderTitle) {
                  if (s.firstPromptPreview) {
                    displayTitle = s.firstPromptPreview;
                    showPromptAsTitle = true;
                  } else if (s.projectName) {
                    displayTitle = `${s.projectName}: ${s.sessionId.slice(-6)}`;
                  }
                }

                const relativeTime = formatRelativeTime(s.lastActivityAt);
                const shortSessionId =
                  s.sessionId.length > 12 ? `${s.sessionId.slice(0, 10)}...` : s.sessionId;

                return (
                  <div
                    key={s.sessionId}
                    className="flex items-center justify-between gap-3 p-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                      {/* Line 1: Title and Status / Badges */}
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="text-xs font-medium text-foreground truncate"
                          title={s.title ? `Official title: ${s.title}` : displayTitle}
                        >
                          {displayTitle}
                        </span>

                        {s.isChild ? (
                          <span className="shrink-0 inline-flex items-center px-1.5 py-0.2 rounded text-3xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            Subagent
                          </span>
                        ) : (
                          <span className="shrink-0 inline-flex items-center px-1.5 py-0.2 rounded text-3xs font-medium bg-muted/60 text-muted-foreground/80 border border-border/40">
                            Root
                          </span>
                        )}

                        {showPromptAsTitle && rawTitle && (
                          <span
                            className="shrink-0 text-3xs px-1 rounded bg-muted/40 text-muted-foreground/60 font-mono"
                            title={`Original server title: ${rawTitle}`}
                          >
                            [{rawTitle}]
                          </span>
                        )}
                      </div>

                      {/* Line 2: Project, Branch, Directory */}
                      <div className="flex items-center gap-2.5 text-2xs text-muted-foreground truncate">
                        {s.projectName && (
                          <span
                            className="flex items-center gap-1 font-medium text-foreground/75 truncate shrink-0 max-w-[130px]"
                            title={`Project: ${s.projectName}`}
                          >
                            <Boxes className="size-3 text-muted-foreground/70 shrink-0" />
                            <span className="truncate">{s.projectName}</span>
                          </span>
                        )}

                        {s.gitBranch && (
                          <span
                            className="flex items-center gap-1 font-mono text-2xs text-muted-foreground/80 truncate shrink-0 max-w-[110px]"
                            title={`Branch: ${s.gitBranch}`}
                          >
                            <GitBranch className="size-3 text-muted-foreground/70 shrink-0" />
                            <span className="truncate">{s.gitBranch}</span>
                          </span>
                        )}

                        <span
                          className="flex items-center gap-1 font-mono truncate text-muted-foreground/70"
                          title={s.directory || "Default workspace"}
                        >
                          <Folder className="size-3 shrink-0 text-muted-foreground/60" />
                          <span className="truncate">
                            {s.directory ? truncateMiddle(s.directory, 32) : "(no directory)"}
                          </span>
                        </span>
                      </div>

                      {/* Line 3: Prompt preview (if not already used as main title) */}
                      {!showPromptAsTitle && s.firstPromptPreview && (
                        <p
                          className="text-2xs text-muted-foreground/80 line-clamp-1 italic font-normal"
                          title={s.firstPromptPreview}
                        >
                          &ldquo;{s.firstPromptPreview}&rdquo;
                        </p>
                      )}

                      {/* Line 4 / Footer: Timestamp & Session ID */}
                      <div className="flex items-center gap-3 text-3xs text-muted-foreground/60">
                        {relativeTime && (
                          <span className="flex items-center gap-1 shrink-0">
                            <Clock className="size-2.5 text-muted-foreground/50" />
                            <span>{relativeTime}</span>
                          </span>
                        )}
                        <span className="font-mono text-3xs text-muted-foreground/50">
                          {shortSessionId}
                        </span>
                      </div>
                    </div>

                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isImporting || importingId !== null}
                      onClick={() => void handleImport(s)}
                      className="shrink-0 h-7 text-xs font-medium px-3"
                    >
                      {isImporting ? (
                        <>
                          <Loader2 className="size-3 animate-spin mr-1" />
                          Importing...
                        </>
                      ) : (
                        "Import"
                      )}
                    </Button>
                  </div>
                );
              })}

              {/* Load More Button */}
              {hasMore && (
                <div className="p-2.5 flex justify-center bg-muted/20">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => void loadMoreSessions()}
                    className="h-7 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="size-3 animate-spin mr-1.5" />
                        Loading more...
                      </>
                    ) : (
                      "Load more sessions"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
