import { useCallback, useEffect, useState } from "react";
import { useAvailabilityStore } from "../../availability/availabilityStore";
import { sidebarConfig } from "../../../config/sidebar";

export interface ConversationItem {
  remoteId: string;
  title?: string;
  status?: string;
  lastMessageAt?: Date;
  engine?: string | null;
}

export interface UseConversationsListOptions {
  search?: string;
  /**
   * Newest-first key. Mirrors `SidebarSortMode` and the server's `order` param
   * one-for-one — no client-side translation, so "Newest first" actually sorts
   * by creation instead of collapsing into "last activity".
   */
  order?: "updated" | "created";
  status?: "regular" | "archived";
  limit?: number;
  /**
   * Sidebar scope. `"simple"` = non-folder chats; `"project"` = folder-bound.
   * Omit for no scope (every conversation) — which is what Recent, the archived
   * page, and global search want.
   */
  workspaceMode?: "simple" | "project";
  /** One folder's project chats. Pairs with `workspaceMode: "project"`. */
  folderId?: string;
}

export interface UseConversationsListResult {
  items: ConversationItem[];
  isLoading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * Lightweight, state-backed projection over TBAi's threadListAdapter.
 * Enforces race-condition protection (latest request wins).
 */
export function useConversationsList(
  options: UseConversationsListOptions = {},
): UseConversationsListResult {
  const {
    search = "",
    order = "updated",
    status,
    limit = 20,
    workspaceMode,
    folderId,
  } = options;

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [page, setPage] = useState<number>(0);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);
  // Coordinated recovery (Phase 3.8): refetch the authoritative list when
  // the backend returns. Failure retains the previous items (catch below).
  const recoveryEpoch = useAvailabilityStore((s) => s.recoveryEpoch);
  useEffect(() => {
    if (recoveryEpoch === 0) return;
    setPage(0);
    setRefreshTrigger((n) => n + 1);
  }, [recoveryEpoch]);

  const refetch = useCallback(() => {
    setPage(0);
    setRefreshTrigger((n) => n + 1);
  }, []);

  const loadMore = useCallback(() => {
    if (hasMore && !isLoading) {
      setPage((p) => p + 1);
    }
  }, [hasMore, isLoading]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    const queryOffset = 0;
    // `limit` grows with each "Load more" (offset stays 0), so clamp to the
    // server's accepted maximum instead of letting a long session request a
    // size the API rejects with a 400.
    const queryLimit = Math.min((page + 1) * limit, sidebarConfig.maxListPageSize);

    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (order) params.set("order", order);
    // Scope is sent (never filtered client-side) so the server's WHERE clause —
    // and therefore `hasMore`/`loadMore` below — describes the rows actually
    // shown. Filtering after the fact would make paging permanently wrong.
    if (workspaceMode) params.set("workspaceMode", workspaceMode);
    if (folderId) params.set("folderId", folderId);
    params.set("limit", String(queryLimit));
    params.set("offset", String(queryOffset));

    fetch(`/api/conversations?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.json() as Promise<{
          threads?: Array<{
            id: string;
            title?: string;
            status?: string;
            lastMessageAt?: string;
            engine?: string | null;
          }>;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        const rawThreads = data.threads ?? [];
        const fetchedItems: ConversationItem[] = rawThreads.map((t) => ({
          remoteId: t.id,
          title: t.title,
          status: t.status,
          lastMessageAt: t.lastMessageAt ? new Date(t.lastMessageAt) : undefined,
          engine: t.engine ?? null,
        }));
        setItems(fetchedItems);
        // At the request ceiling there may be more rows, but we will not ask
        // for them — hide the button rather than offer a click that changes
        // nothing.
        setHasMore(
          rawThreads.length >= queryLimit &&
            queryLimit < sidebarConfig.maxListPageSize,
        );
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [search, order, status, limit, page, refreshTrigger, workspaceMode, folderId]);

  return {
    items,
    isLoading,
    error,
    hasMore,
    loadMore,
    refetch,
  };
}
