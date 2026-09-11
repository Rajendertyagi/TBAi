import { createRemoteThreadListAdapter } from "../adapters/remoteThreadListAdapter";

/**
 * Module-scope thread-list adapter singleton. Stateless apart from React
 * hooks it hosts; safe to share across the shell, views, and tab store
 * validation (previously created per-App via useMemo).
 */
export const threadListAdapter = createRemoteThreadListAdapter();
