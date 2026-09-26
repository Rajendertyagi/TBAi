import { useEffect } from "react";
import { sidebarConfig } from "../../../config/sidebar";
import {
  setThreadListSearchQuery,
  setThreadListSortOrder,
} from "../../../adapters/remoteThreadListAdapter";
import { useDesktopLayout } from "../../desktop/state/desktopLayout";

/**
 * Syncs the store-owned search query + sort mode into the thread-list adapter.
 *
 * No debounce here on purpose: `desktopLayout.searchQuery` has already settled
 * (`searchDebounceMs` is applied once, at the input boundary in the store), so a
 * timer in this hook would only add a second, redundant delay before the
 * adapter sees the same value.
 */
export function useThreadListQuerySync(): void {
  const searchQuery = useDesktopLayout((s) => s.searchQuery);
  const sidebarSort = useDesktopLayout((s) => s.sidebarSort);

  useEffect(() => {
    setThreadListSortOrder(sidebarSort);
  }, [sidebarSort]);

  useEffect(() => {
    if (searchQuery.trim().length < sidebarConfig.searchMinLength) {
      setThreadListSearchQuery("");
      return;
    }
    setThreadListSearchQuery(searchQuery);
  }, [searchQuery]);
}
