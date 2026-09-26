import { createResumableStreamContext } from "assistant-stream/resumable";
import { db } from "../db";
import { APP_BOOT_ID } from "../services/chat-streams/boot";
import { createSqliteResumableStreamStore } from "../services/chat-streams/sqliteResumableStore";

/**
 * Official assistant-stream resumable-stream context, now backed by the durable
 * SQLite store instead of the in-memory one.
 *
 * Only the *implementation* of `ResumableStreamStore` changed: the streaming
 * contract, the resume protocol, `/api/chat/resume`, and the UI-message format
 * are untouched (ADR: docs/decisions.md "ADR: Direct Chat durable resumable
 * streams"; design docs/2026-09-25-phase2-durability-design.md).
 *
 * There is exactly ONE store instance for the process, shared by the context
 * here and by the Direct route's durable settlement, so both observe the same
 * rows. It reuses the application SQLite handle — no second database.
 *
 * Constructed once per process. `APP_BOOT_ID` identifies this process
 * generation, which is what lets boot recovery recognise (and never relabel)
 * rows left `streaming` by an earlier boot.
 *
 * The Direct chat route's AI funnel remains the single owner of stream-error
 * classification and logging, so the hook stays intentionally empty: this lower
 * layer must not add a second `ai.error` entry for the same producer failure.
 */
export const chatStreamStore = createSqliteResumableStreamStore({
  db,
  bootId: APP_BOOT_ID,
});

export const resumableContext = createResumableStreamContext({
  store: chatStreamStore,
  onError: () => {},
});
