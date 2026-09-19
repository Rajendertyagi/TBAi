import { useCallback, useEffect, useState } from "react";

export interface ConversationItem {
  remoteId: string;
  title?: string;
  status?: string;
  lastMessageAt?: Date;
  engine?: string | null;
}

export interface UseConversationsListOptions {
  search?: string;
  order?: "newest" | "oldest" | "title";
  status?: "regular" | "archived";
  limit?: number;
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
  const { search = "", order = "newest", status, limit = 20 } = options;

  const [items, setItems] = useState<ConversationItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [page, setPage] = useState<number>(0);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);

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
    const queryLimit = (page + 1) * limit;

    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (order) params.set("order", order);
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
        setHasMore(rawThreads.length >= queryLimit);
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
  }, [search, order, status, limit, page, refreshTrigger]);

  return {
    items,
    isLoading,
    error,
    hasMore,
    loadMore,
    refetch,
  };
}
