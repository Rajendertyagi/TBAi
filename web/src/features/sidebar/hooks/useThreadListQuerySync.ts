import { useEffect } from "react";
import { sidebarConfig } from "../../../config/sidebar";
import {
  setThreadListSearchQuery,
  setThreadListSortOrder,
} from "../../../adapters/remoteThreadListAdapter";
import { useDesktopLayout } from "../../desktop/state/desktopLayout";

/**
 * Syncs the store-owned search query + sort mode into the thread-list adapter.
 */
export function useThreadListQuerySync(): void {
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);

  useEffect(() => {
    setThreadListSortOrder(sidebarSort);
  }, [sidebarSort]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length > 0 && query.length < sidebarConfig.searchMinLength) return;
    const t = setTimeout(() => {
      setThreadListSearchQuery(searchQuery);
    }, sidebarConfig.searchDebounceMs);
    return () => clearTimeout(t);
  }, [searchQuery]);
}

