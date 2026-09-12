import { useEffect } from "react";
import { useAui } from "@assistant-ui/react";
import { sidebarConfig } from "../../../config/sidebar";
import {
  setThreadListSearchQuery,
  setThreadListSortOrder,
} from "../../../adapters/remoteThreadListAdapter";
import { useDesktopLayout } from "../../desktop/state/desktopLayout";

/** Ask the runtime to reload page 1 of the thread list (best-effort). */
export function reloadThreadList(aui: unknown): void {
  try {
    const client = aui as unknown as Record<
      string,
      { getState?: () => { reload?: () => unknown } } | undefined
    >;
    client.threads?.getState?.()?.reload?.();
  } catch {
    /* runtime reload unavailable; client filter still applies */
  }
}

/**
 * Syncs the store-owned search query + sort mode into the thread-list adapter
 * (server-side `?search=` / `?order=`) and reloads page 1, debounced. Mounted
 * by the Sidebar; the chrome search input only writes the store.
 */
export function useThreadListQuerySync(): void {
  const aui = useAui();
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);

  useEffect(() => {
    setThreadListSortOrder(sidebarSort);
    reloadThreadList(aui);
  }, [sidebarSort, aui]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length > 0 && query.length < sidebarConfig.searchMinLength) return;
    const t = setTimeout(() => {
      setThreadListSearchQuery(searchQuery);
      reloadThreadList(aui);
    }, sidebarConfig.searchDebounceMs);
    return () => clearTimeout(t);
  }, [searchQuery, aui]);
}
