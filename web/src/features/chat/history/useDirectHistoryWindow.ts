/**
 * P2 Direct History Window â€” the production bridge between SQLite's bounded
 * window and the live assistant-ui Direct runtime.
 *
 * ## Where it plugs in (and why)
 *
 * A persisted Direct thread loads its history through ONE writer:
 * `adapters.history.withFormat(fmt).load()`. Upstream then does, in
 * `useExternalHistory`:
 *
 *   toExportedMessageRepository(toThreadMessages, repo)   // upstream converter
 *   runtime.thread.import(converted)                     //   + write-back binding
 *   tempRepo.getMessages()                               // branch -> visible path
 *   chatHelpers.setMessages(...)                         // -> live useChat state
 *
 * So this module makes that ONE existing call return a BOUNDED window instead of
 * the whole conversation, carrying PERSISTED parent ids. Nothing else about the
 * path changes: upstream still owns conversion, binding, branching and streaming,
 * and `useChat` remains the live execution source.
 *
 * `messageRepository` is deliberately NOT used. Upstream documents it as a
 * one-shot seed for threads that have no history adapter ("Persisted threads
 * that already go through `adapters.history` do not need this"), and
 * `useAISDKRuntime` only feeds it while the chat is initially empty â€” so a
 * repeatedly-committing window cannot be driven through it, and running both
 * creates two competing history writers.
 *
 * ## Paging
 *
 * `hasEarlier` / `onLoadEarlier` exist on `ExternalStoreAdapter`, but
 * `pickExternalStoreSharedOptions` does not forward them, so the AI SDK runtime
 * cannot execute them (`ThreadPrimitive.LoadEarlier` is permanently inert on
 * this path). Paging therefore uses upstream's own host-facing mechanism
 * instead: `useAISDKChat().setMessages(...)`, the same function upstream calls
 * to install its seed. Stable persisted ids are what keep rendered rows and
 * scroll position in place.
 *
 * ## Ownership
 *
 * This module owns no window policy. `WindowController` owns the window state
 * and the merge, and `historyWindow` owns the window bookkeeping.
 *
 * On anchors: an earlier version of this comment claimed the controller's
 * `anchors` were REQUIRED and "only ever filled from real DOM measurement".
 * That was inaccurate, and the controller's own doc is the correct one â€”
 * `anchors` is OPTIONAL, defaults to `{ top: null, bottom: null }`
 * (`windowController.ts:171`), and this module never supplies it. It is carried
 * into `state.protectedRegion`, which nothing reads.
 *
 * Nothing is broken by that, because prepend stability does not come from
 * anchors here: it comes from TanStack Virtual's `anchorTo: 'end'`, which
 * re-finds the same keyed row after the data changes and compensates the
 * offset itself (see `VirtualizedTranscript.tsx`). The anchors are a leftover of
 * the retired eviction design, which is what needed a measured protected
 * region. They are left in place rather than removed because
 * `docs/decisions.md:3871` still records `computeProtectedRegion` as a surviving
 * responsibility; whether to complete or retire that path is an open decision,
 * not something to change silently. See
 * `docs/2026-10-10-history-window-and-test-relocation-handoff.md` Part F.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAISDKChat } from "@assistant-ui/ai-sdk";
import { apiFetch } from "../../../lib/platform";
import { logger } from "../../../lib/logger";
import { HISTORY_WINDOW_FETCH_TIMEOUT_MS } from "../../../config/history";
import {
  WindowController,
  WindowControllerError,
  type PersistedRow,
  type WindowSliceResponse,
} from "./windowController";
import {
  IDLE_RUNTIME,
  type RuntimeActivity,
} from "./historyWindow";

/** Default bounded window size for Direct. The core may evict either side to keep it. */
export const DEFAULT_WINDOW_LIMIT = 100;
/** Messages rendered beyond the measured viewport before eviction may touch them. */
export const DEFAULT_WINDOW_OVERSCAN = 20;

/** A stored row exactly as SQLite persists it: the envelope, never interpreted. */
export type StoredRow = {
  readonly id: string;
  readonly parent_id: string | null;
  readonly format: string;
  readonly content: unknown;
};

/**
 * Decodes a stored row with the runtime's OWN format adapter, yielding the
 * `{ parentId, message }` pair upstream's converter expects. This is the only
 * place stored content becomes a runtime message, and it is the format
 * adapter's job, not ours.
 */
export type RowDecoder = (stored: StoredRow) => { parentId: string | null; message: unknown };

/* â”€â”€ module state (per conversation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

type ControllerSlot = {
  /** Assigned immediately after construction; read only once it exists. */
  controller?: WindowController;
};

const controllers = new Map<string, ControllerSlot>();
const activities = new Map<string, RuntimeActivity>();

const readWindowSlice = async (
  conversationId: string,
  direction: "older" | "newer",
  anchorId: string | null,
  limit: number,
  signal?: AbortSignal,
): Promise<{ rows: readonly StoredRow[]; slice: Omit<WindowSliceResponse, "messages"> }> => {
  // A null anchor means "start at the tip". It is omitted rather than sent as an
  // empty string: the query schema requires a non-empty id when one is present,
  // so `anchorId=` is a 400 rather than the documented null default.
  const query = new URLSearchParams({ direction, limit: String(limit) });
  if (anchorId !== null) query.set("anchorId", anchorId);
  const res = await apiFetch(
    `/api/conversations/${conversationId}/messages/window?${query}`,
    signal ? { signal } : undefined,
  );
  if (!res.ok) throw new Error(`Failed to load history window (${res.status})`);
  const data = (await res.json()) as {
    messages: StoredRow[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    contiguous: boolean;
    complete: boolean;
  };
  return {
    rows: data.messages ?? [],
    slice: {
      hasMoreBefore: data.hasMoreBefore,
      hasMoreAfter: data.hasMoreAfter,
      contiguous: data.contiguous,
      complete: data.complete,
    },
  };
};

/**
 * Get (or create) the bounded window for a conversation.
 *
 * `decode` is captured from the history adapter's `withFormat`, so the rows this
 * controller commits are already the runtime's message shape. Creating it twice
 * is impossible: the first caller wins, and a later conversation reload reuses
 * the same controller rather than silently discarding a window the user built.
 */
/** Thrown when one window request exceeds `HISTORY_WINDOW_FETCH_TIMEOUT_MS`. */
export class HistoryWindowTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`history window request exceeded ${timeoutMs}ms`);
    this.name = "HistoryWindowTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * One bounded window request.
 *
 * The deadline exists so the load always SETTLES. An unbounded fetch leaves
 * `load()` pending forever, which suppresses the failure flag that recovery and
 * the Retry control both depend on. The timer is cleared on every settlement
 * path, so a fast response leaves nothing pending, and the signal is scoped to
 * this one request so aborting it cannot disturb another conversation's.
 */
async function fetchWindowSliceBounded(
  conversationId: string,
  direction: "older" | "newer",
  anchorId: string | null,
  limit: number,
): Promise<{ rows: readonly StoredRow[]; slice: Omit<WindowSliceResponse, "messages"> }> {
  const timeoutMs = HISTORY_WINDOW_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // The deadline REJECTS THE RACE rather than waiting for the request to notice
  // the abort. Relying on the abort alone is not enough: `apiFetch` can be stuck
  // before it ever reaches `fetch` (the Tauri preflight that awaits
  // `ensureApiBaseUrl()` runs first, and the signal is not wired into it), and a
  // promise that has not started a fetch cannot be aborted. Racing guarantees the
  // load settles at the deadline no matter where the request is parked; the abort
  // is still issued so an in-flight request is genuinely cancelled.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new HistoryWindowTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    const pending = readWindowSlice(conversationId, direction, anchorId, limit, controller.signal);
    // Once the deadline has won, a later rejection from the abandoned request is
    // no longer observed. Left unhandled it is an unhandled rejection, which
    // crashes the process, so it is absorbed here.
    void pending.catch(() => undefined);
    return await Promise.race([pending, deadline]);
  } catch (error) {
    // An abort we raised is a timeout, not a transport error, and the two must not
    // be reported as the same thing.
    if (timedOut) throw new HistoryWindowTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function ensureWindowController(
  conversationId: string,
  decode: RowDecoder,
): WindowController {
  const existing = controllers.get(conversationId);
  if (existing?.controller) return existing.controller;

  const controller = new WindowController({
    limit: DEFAULT_WINDOW_LIMIT,
    overscan: DEFAULT_WINDOW_OVERSCAN,
    activity: () => activities.get(conversationId) ?? IDLE_RUNTIME,
    fetchWindow: async ({ direction, anchorId, limit }): Promise<WindowSliceResponse> => {
      const { rows, slice } = await fetchWindowSliceBounded(
        conversationId,
        direction,
        anchorId,
        limit,
      );
      // A row with no stored content cannot be decoded. Dropping it would leave a
      // hole, which the frozen core treats as a broken window â€” fail-closed by
      // returning the row so the invariant check refuses the commit.
      const decoded: PersistedRow[] = rows.map((row) => {
        if (row.content == null) {
          throw new WindowControllerError("incomplete-slice", [row.id], "undecodable row");
        }
        const item = decode(row);
        return {
          id: row.id,
          parentId: item.parentId ?? null,
          format: row.format,
          content: row.content,
          message: item.message,
        };
      });
      return { ...slice, messages: decoded };
    },
  });

  controllers.set(conversationId, { controller });
  return controller;
}

/** The committed window for a conversation, or undefined before its first load. */
export function windowControllerFor(conversationId: string | null): WindowController | null {
  return conversationId ? (controllers.get(conversationId)?.controller ?? null) : null;
}

/** Forget a conversation's window (used when a conversation is deleted). */
export function dropWindowController(conversationId: string): void {
  // Deleting the conversation must not leave a reload latched: nothing will
  // settle for it any more, and a held latch would block Retry permanently.
  endHistoryReload(conversationId);
  controllers.delete(conversationId);
  activities.delete(conversationId);
  uiSnapshots.delete(conversationId);
  // Coordinated recovery forces a fresh, authoritative read, so a stale failure
  // record must not outlive the window it described.
  loadFailures.delete(conversationId);
  recoveryAttempted.delete(conversationId);
}

/** Forget every conversation's window (coordinated recovery / full reset). */
export function clearAllWindowControllers(): void {
  for (const id of [...controllers.keys()]) dropWindowController(id);
  resetHistoryVisit();
  for (const listener of uiListeners) listener();
}

/* â”€â”€ UI-facing window state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export type DirectHistoryWindowUi = {
  /** Bumped on every committed navigation, so views can re-read the window. */
  readonly revision: number;
  readonly historical: boolean;
  readonly hasEarlier: boolean;
  readonly hasMoreAfter: boolean;
  /**
   * The last attempt to load this conversation's history FAILED or was refused
   * as incomplete. It is never set for a conversation that genuinely holds no
   * messages: an empty conversation loads successfully with zero rows, which is
   * a different answer from a load that never arrived.
   */
  readonly loadFailed: boolean;
};

const EMPTY_UI: DirectHistoryWindowUi = {
  revision: 0,
  historical: false,
  hasEarlier: false,
  hasMoreAfter: false,
  loadFailed: false,
};

const uiSnapshots = new Map<string, DirectHistoryWindowUi>();
const uiListeners = new Set<() => void>();

/**
 * Per-conversation record of a FAILED history load.
 *
 * This is the only state that distinguishes "the server refused or could not
 * answer" from "the conversation is genuinely empty": both end with zero rows in
 * the controller, but only a failure ever passes through a throw. Module-scoped
 * (like `controllers` and `uiSnapshots`) so the record survives the unmount that
 * a thread switch causes and is still readable when the user comes back.
 */
const loadFailures = new Set<string>();

/**
 * The conversation whose Direct surface was most recently mounted.
 *
 * ## Why this exists
 *
 * A failed history load earns ONE automatic recovery attempt, recorded
 * module-scoped so the recovery's own runtime restart â€” which REMOUNTS this
 * surface â€” cannot fire a second one. The cost of that record is that it never
 * expires: switching threads does not detach a started thread, so a conversation
 * that failed stayed failed with its budget spent, and coming back to it bought
 * nothing. The transcript simply rendered empty.
 *
 * A new visit has to be told apart from the restart's own remount, and it cannot
 * be read off this component's lifecycle. The Direct surface renders ONE window
 * bound to the ACTIVE thread (`ChatView`), so leaving a conversation UNMOUNTS it:
 * `isMain` never goes false in a live instance, and a mount that is already main
 * is indistinguishable from the restart's.
 *
 * What does distinguish them is which conversation was here last. The restart
 * remounts the SAME conversation, so it sees no change; arriving from somewhere
 * else sees a different id. That is a real user action, so it is the signal.
 */
let lastMountedConversationId: string | null = null;

/**
 * Record which conversation the Direct surface is now showing, and report
 * whether this mount is a NEW VISIT rather than a remount of the same one.
 *
 * Call this from an effect, once per mount, BEFORE consuming the recovery
 * budget: the re-arm and the attempt have to happen in the same step so no render
 * can slip between clearing an exhausted budget and spending it.
 *
 * @param conversationId - The conversation this surface just mounted for.
 * @returns True when the previous mount was a DIFFERENT conversation, i.e. the
 * user arrived here rather than the runtime restarting under them.
 */
export function beginHistoryVisit(conversationId: string): boolean {
  if (lastMountedConversationId === conversationId) return false;
  lastMountedConversationId = conversationId;
  return true;
}

/** Forget the last-mounted conversation (coordinated recovery / full reset). */
export function resetHistoryVisit(): void {
  lastMountedConversationId = null;
}

/**
 * Record that a conversation's history load failed.
 *
 * Call this ONLY from the failure path. An empty conversation is not a failure
 * and must never be marked, or recovery would retry a thread that has nothing
 * to load.
 *
 * This is also the only place a failed load becomes observable. The flag drives
 * recovery, and recovery is bounded: a thread whose backend stays unreachable
 * stops being retried once its budget is spent for a visit, and a started thread
 * is never detached, so nothing else would report it. Without a diagnostic the
 * transcript simply renders empty and the cause is undiscoverable â€”
 * indistinguishable from a conversation that genuinely has no messages. Emitted
 * on the TRANSITION only, so a repeatedly failing load cannot flood the log.
 */
export function markHistoryLoadFailed(conversationId: string): void {
  // The load SETTLED (failed), so a user-triggered reload is no longer running.
  endHistoryReload(conversationId);
  if (loadFailures.has(conversationId)) return;
  loadFailures.add(conversationId);
  logger.warn("chat", "history.load_failed", { conversationId });
}

/**
 * Clear the failure record. Only a successful fetch or an authoritative cache
 * invalidation may do this â€” never the passage of time or a re-render.
 */
export function clearHistoryLoadFailed(conversationId: string): void {
  // The load SETTLED (succeeded). Released unconditionally, BEFORE the early
  // return below: a reload that succeeds clears no failure flag (there was none),
  // and leaving the latch held then would disable Retry for good.
  endHistoryReload(conversationId);
  if (!loadFailures.delete(conversationId)) return;
  logger.info("chat", "history.load_recovered", { conversationId });
}

/** Whether this conversation's most recent history load failed. */
export function isHistoryLoadFailed(conversationId: string | null | undefined): boolean {
  return conversationId !== null && conversationId !== undefined && loadFailures.has(conversationId);
}

/**
 * Conversations a recovery refresh has already been requested for.
 *
 * Module-scoped on purpose. The refresh restarts the thread runtime, which
 * REMOUNTS everything inside it â€” including the component that requested it â€” so
 * a `useRef` latch would be recreated as `null` and the request would fire
 * again, producing a second `load()` per entry. This set survives that remount.
 *
 * A conversation is forgotten from it as soon as its failure clears, so a later,
 * separate failure can be recovered again.
 */
const recoveryAttempted = new Set<string>();

/** True when a recovery refresh has already been requested for this conversation. */
export function hasAttemptedHistoryRecovery(conversationId: string): boolean {
  return recoveryAttempted.has(conversationId);
}

/** Record that a recovery refresh was requested for this conversation. */
export function markHistoryRecoveryAttempted(conversationId: string): void {
  recoveryAttempted.add(conversationId);
}

/**
 * Forget a conversation's recovery attempt. Call when its failure has cleared,
 * so a future failure is recoverable rather than permanently suppressed.
 */
export function clearHistoryRecoveryAttempted(conversationId: string): void {
  recoveryAttempted.delete(conversationId);
}

/**
 * Conversations with a USER-TRIGGERED history reload in flight.
 *
 * ## Why a separate record from `recoveryAttempted`
 *
 * `recoveryAttempted` answers "has an automatic refresh already been spent?".
 * This answers "is a refresh the user just asked for still running?", which is a
 * different question with a different lifetime: the budget is spent once per
 * visit and is only re-armed deliberately, whereas this latch is released as
 * soon as the load settles.
 *
 * ## Why module-scoped
 *
 * `reloadMainThread()` restarts the thread runtime, which REMOUNTS the surface
 * that requested it. A `useRef` or component-state latch would be recreated as
 * empty by that remount and could not stop the second refresh.
 *
 * ## Why overlapping loads are actually dangerous
 *
 * `useExternalHistory` calls `load()` with NO abort signal and NO effect cleanup,
 * and a completed load calls `thread.import(...)` on the live runtime. Two
 * concurrent loads therefore do not merely waste requests: whichever finishes
 * last overwrites the other's messages. Measured against the real adapter, a
 * slow SUCCESS from an older load also erases a failure recorded by a newer one.
 * One load at a time is the invariant that prevents both.
 */
const historyReloadsInFlight = new Set<string>();

/**
 * Claim the single-flight slot for a user-triggered history reload.
 *
 * Call this SYNCHRONOUSLY in the click handler, before awaiting anything. Two
 * clicks dispatched in one tick both observe `thread.isLoading === false` (the
 * restart has not happened yet), so without this latch both would start a load.
 *
 * @returns True when the caller now owns the reload and must perform it; false
 * when one is already in flight, in which case the caller must do nothing.
 */
export function beginHistoryReload(conversationId: string): boolean {
  if (historyReloadsInFlight.has(conversationId)) return false;
  historyReloadsInFlight.add(conversationId);
  return true;
}

/** True while a user-triggered reload for this conversation is still running. */
export function isHistoryReloadInFlight(conversationId: string): boolean {
  return historyReloadsInFlight.has(conversationId);
}

/**
 * Release the single-flight slot.
 *
 * Both load outcomes pass through this module â€” `markHistoryLoadFailed` from the
 * adapter's catch and `clearHistoryLoadFailed` from its success path â€” so those
 * are the load-SETTLED boundaries, and releasing there is what makes the latch
 * safe rather than a leak.
 *
 * Releasing on an arbitrary settle would be unsound only if another load could be
 * running; it cannot, because a retry is only offered while `thread.isLoading`
 * is false, so any settle observed while the slot is held belongs to the reload
 * that took it.
 */
function endHistoryReload(conversationId: string): void {
  historyReloadsInFlight.delete(conversationId);
}

const subscribeUi = (onChange: () => void): (() => void) => {
  uiListeners.add(onChange);
  return () => uiListeners.delete(onChange);
};

/**
 * Republish a conversation's window state to React.
 *
 * Every call stores a NEW snapshot object, so `useSyncExternalStore` sees a
 * changed reference and subscribers re-render on each publish. The comparison
 * below is not a render guard â€” it decides whether the snapshot is rebuilt from
 * `current` or from `next`, and any field left out of it is carried forward from
 * the PREVIOUS value instead of the one just computed. That is why every field
 * this function can emit must appear in the comparison.
 */
export function publishWindowUi(conversationId: string, controller: WindowController): void {
  const next: DirectHistoryWindowUi = {
    revision: (uiSnapshots.get(conversationId)?.revision ?? 0) + 1,
    historical: controller.historical,
    hasEarlier: controller.hasMoreBefore,
    hasMoreAfter: controller.hasMoreAfter,
    loadFailed: loadFailures.has(conversationId),
  };
  const current = uiSnapshots.get(conversationId);
  if (
    current &&
    current.historical === next.historical &&
    current.hasEarlier === next.hasEarlier &&
    current.hasMoreAfter === next.hasMoreAfter &&
    // `loadFailed` MUST be compared here. This branch rebuilds the snapshot from
    // `current`, so any field left out of the comparison is carried forward from
    // the PREVIOUS value instead of the one just computed. Omit `loadFailed` and a
    // failure that changes nothing else takes this branch and republishes the
    // stale `loadFailed: false` â€” the recovery would then silently never fire
    // while every other value still read correctly.
    current.loadFailed === next.loadFailed
  ) {
    uiSnapshots.set(conversationId, { ...current, revision: next.revision });
  } else {
    uiSnapshots.set(conversationId, next);
  }
  for (const listener of uiListeners) listener();
}

/**
 * How a controller relates to the one currently registered for a conversation.
 *
 * The distinction matters because "not current" is not one condition. A
 * controller can be replaced by a newer one, or dropped by coordinated recovery
 * with nothing put back yet, and those two demand opposite responses.
 */
export type WindowControllerStanding =
  /** Registered and identical: its state is authoritative. */
  | "current"
  /** Dropped, and nothing has replaced it: its freshly fetched window is the newest. */
  | "orphaned"
  /** A different controller owns the conversation: its state is stale and must not win. */
  | "superseded";

/**
 * Classify `controller` against the conversation's registered controller.
 *
 * This is the single decision every caller that holds a controller across an await
 * must make. It is deliberately separate from `publishWindowUiFor` so a caller can
 * gate side effects that are not the UI snapshot — clearing a failure flag, writing
 * a cache, returning messages to the runtime — without publishing anything first.
 */
export function windowControllerStanding(
  conversationId: string,
  controller: WindowController,
): WindowControllerStanding {
  const registered = controllers.get(conversationId)?.controller;
  if (!registered) return "orphaned";
  return registered === controller ? "current" : "superseded";
}

/**
 * Publish UI state on behalf of a controller that may have been invalidated while
 * an asynchronous operation was in flight.
 *
 * Coordinated recovery drops every controller (`clearAllWindowControllers`), but a
 * load already in flight still holds its controller in a closure and publishes
 * with it when it settles. Publishing unconditionally resurrects paging state for
 * a controller nobody owns any more: the UI renders a "Load earlier" control whose
 * handler resolves no controller and silently does nothing.
 *
 * Two outcomes, and the difference matters:
 *
 *  - **Superseded.** A different controller is registered for this conversation.
 *    The late completion is stale in the strict sense and must NOT publish: it
 *    would clobber newer, authoritative state.
 *  - **Orphaned.** Nothing is registered â€” recovery dropped the controller and no
 *    replacement has been built. The window this load just fetched is the freshest
 *    thing that exists for the conversation, and `useExternalHistory` latches
 *    `load()` per mount, so discarding it would leave the transcript populated but
 *    permanently unpageable. It is re-adopted and published, which is what keeps
 *    the conversation usable instead of merely hiding the control.
 *
 * @returns Whether state was published.
 */
export function publishWindowUiFor(
  conversationId: string,
  controller: WindowController,
): boolean {
  if (windowControllerStanding(conversationId, controller) === "superseded") return false;
  if (windowControllerStanding(conversationId, controller) === "orphaned") {
    controllers.set(conversationId, { controller });
  }
  publishWindowUi(conversationId, controller);
  return true;
}

const readUiSnapshot = (conversationId: string | null): DirectHistoryWindowUi =>
  (conversationId ? uiSnapshots.get(conversationId) : undefined) ?? EMPTY_UI;

/**
 * The window's UI state for a conversation.
 *
 * Read by the runtime hook itself (`isSendDisabled` while historical) and by
 * the viewport/control that report anchors and offer paging.
 */
export function useDirectHistoryWindowUi(conversationId: string | null): DirectHistoryWindowUi {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeUi(onChange),
    [],
  );
  const getSnapshot = useCallback(() => readUiSnapshot(conversationId), [conversationId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* â”€â”€ the Direct window hook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

/**
 * The message shape `useAISDKChat()` deals in, derived from the public hook
 * itself rather than restated, so it cannot drift from the installed package.
 *
 * A window row's `message` is produced by the runtime's OWN format adapter, so
 * it is this type by construction; the narrowing happens once, here.
 */
type ChatMessage = NonNullable<ReturnType<typeof useAISDKChat>>["messages"][number];

const asChatMessage = (row: PersistedRow): ChatMessage => row.message as ChatMessage;

export type DirectHistoryWindow = {
  readonly controller: WindowController | null;
  /** Whether older messages exist before the window's first message. */
  readonly hasEarlier: boolean;
  /** True while the controller shows a non-submittable historical window. */
  readonly isHistorical: boolean;
  /** The authoritative tip of the selected chain, preserved across navigation. */
  readonly authoritativeTip: string | null;
  /** Persisted ids in the committed window, in render order. */
  readonly windowIds: readonly string[];
  /** Load one older page and prepend it with its stable persisted ids. */
  readonly loadEarlier: () => Promise<void>;
  /**
   * True when this conversation's most recent history load failed. An empty
   * conversation is NOT a failure: a zero-row slice is a successful answer.
   */
  readonly loadFailed: boolean;
  /** Enter a non-submittable historical window positioned at `targetId`. */
  readonly goHistorical: (targetId: string) => Promise<void>;
  /** Return to the authoritative active window. Idempotent at the tip. */
  readonly restoreTip: () => Promise<void>;
  /** Persisted write-back from the runtime's binding-carrying messages. */
  readonly writeBack: typeof WindowController.prototype.writeBack;
};

/**
 * Owns bounded-history navigation for the mounted Direct conversation.
 *
 * Must be called inside the assistant-ui runtime provider: it reaches the live
 * AI SDK chat through `useAISDKChat()`, the public accessor upstream provides,
 * and applies page changes with the same `setMessages` upstream itself uses.
 */

/** Installs a window's messages as the live feed. Bound by the caller so this
 *  module never has to be structurally compatible with the runtime's own,
 *  overloaded `setMessages` signature. */
export type WindowInstaller = (messages: ChatMessage[]) => void;

/**
 * Install a controller's committed window as the live message list - unless that
 * controller has been superseded.
 *
 * This is the ONE point where a navigation result becomes live chat state, so the
 * currency check lives here rather than at each caller. `goHistorical` and
 * `restoreTip` both await the controller first, and a replacement registered during
 * that await would otherwise have its window overwritten by the one it replaced - a
 * write no later publish guard can undo.
 *
 * Exported so the guard is exercised as the production function rather than a
 * re-implementation of it.
 *
 * @returns Whether the live feed was written.
 */
export function applyWindowToChat(
  conversationId: string,
  install: WindowInstaller | null | undefined,
  target: WindowController,
): boolean {
  if (!install) return false;
  if (windowControllerStanding(conversationId, target) === "superseded") {
    logger.warn("chat", "history.navigation_superseded", { conversationId });
    return false;
  }
  install(target.rows().map(asChatMessage));
  return true;
}

export function useDirectHistoryWindow(conversationId: string | null): DirectHistoryWindow {
  const ui = useDirectHistoryWindowUi(conversationId);
  const chat = useAISDKChat();

  const controller = useMemo(
    () => windowControllerFor(conversationId),
    // `ui.revision` is the signal that a commit replaced the controller's rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId, ui.revision],
  );

  /** Refuse navigation while a run or an interaction holds runtime state. */
  const isBusy = useCallback((): boolean => {
    const status = chat?.status;
    return status === "streaming" || status === "submitted";
  }, [chat]);


  /**
   * Load one older page and PREPEND it.
   *
   * This is upstream's paging contract verbatim: the host prepends the previous
   * page and the stable persisted ids keep rendered rows and scroll position in
   * place. Nothing is removed, because the live chat array is the execution
   * feed, not the loading window â€” the bound belongs to the controller, which
   * still evicts, and whose window is what every invariant test measures.
   */
  const loadEarlier = useCallback(async () => {
    if (!conversationId || !controller || !chat) return;
    if (isBusy()) return;
    if (!controller.hasMoreBefore) return;

    const beforeCount = controller.rows().length;
    const alreadyLoaded = new Set(chat.messages.map((m) => m.id));

    try {
      // Paging back is the historical transition: the window is no longer the
      // active tip run, so it becomes non-submittable until the tip is restored.
      await controller.loadOlder({ historical: true });
    } catch (error) {
      // Fail closed: a refused commit leaves the window exactly as it was.
      //
      // Recorded here, at the failure itself, rather than left to the caller: the
      // window is deliberately unchanged, so a paging failure is otherwise
      // indistinguishable from a click that did nothing. The event name is
      // deliberately distinct from `history.load_failed` â€” that one means the
      // initial load never arrived and drives the full-reload Retry row, which
      // would be a false claim while messages are already on screen.
      // Currency first: a failure from a controller that no longer owns the
      // conversation must not be attributed to the healthy replacement.
      if (windowControllerStanding(conversationId, controller) === "superseded") {
        logger.warn("chat", "history.page_load_superseded", { conversationId });
        throw error;
      }
      // A bounded request that hit its deadline is a DIFFERENT failure from a
      // refused one, and it is the one that matters most here: it means the load
      // was abandoned rather than rejected, so the window is untouched and the
      // next attempt is worth making.
      if (error instanceof HistoryWindowTimeoutError) {
        logger.warn("chat", "history.page_load_timeout", {
          conversationId,
          timeoutMs: error.timeoutMs,
        });
      } else {
        logger.warn("chat", "history.page_load_failed", { conversationId });
      }
      publishWindowUiFor(conversationId, controller);
      throw error;
    }

    // Currency is checked BEFORE the live feed is touched. A superseded controller
    // still holds committed rows, and prepending them would inject an older window
    // into a conversation a newer controller already owns - the same clobber the
    // publish guard exists to prevent, one layer down.
    if (windowControllerStanding(conversationId, controller) === "superseded") {
      logger.warn("chat", "history.page_load_superseded", { conversationId });
      return;
    }

    const rows = controller.rows();
    const page = rows.length > beforeCount ? rows.slice(0, rows.length - beforeCount) : [];
    // Duplicate-free: an id already in the live feed is never prepended twice.
    const fresh = page.filter((r) => !alreadyLoaded.has(r.id)).map(asChatMessage);
    if (fresh.length > 0) chat.setMessages((current) => [...fresh, ...current]);

    publishWindowUiFor(conversationId, controller);
  }, [chat, controller, conversationId, isBusy]);

  /**
   * Install the whole committed window, which is what repositioning the window
   * means: the bounded window becomes the live message list.
   */
  const applyWindow = useCallback(
    (target: WindowController) => {
      if (!conversationId) return;
      if (!chat) return;
      applyWindowToChat(conversationId, (messages) => chat.setMessages(messages), target);
    },
    [chat, conversationId],
  );

  const goHistorical = useCallback(
    async (targetId: string) => {
      if (!conversationId || !controller || isBusy()) return;
      await controller.goHistorical(targetId);
      applyWindow(controller);
      publishWindowUiFor(conversationId, controller);
    },
    [applyWindow, controller, conversationId, isBusy],
  );

  const restoreTip = useCallback(async () => {
    if (!conversationId || !controller || isBusy()) return;
    // Idempotent by contract: walking `newer` from the tip is a no-op, not an
    // error, so restoring while already active never disturbs the window.
    await controller.restoreTip();
    if (!controller.historical) applyWindow(controller);
    publishWindowUiFor(conversationId, controller);
  }, [applyWindow, controller, conversationId, isBusy]);

  /** Keep the frozen core informed of live runtime state before any commit. */
  const reportActivity = useCallback(
    (isStreaming: boolean) => {
      if (!conversationId) return;
      activities.set(conversationId, {
        isStreaming,
        hasPendingApproval: false,
        hasPendingQuestion: false,
      });
    },
    [conversationId],
  );

  useMemo(() => {
    reportActivity(chat?.status === "streaming");
  }, [chat?.status, reportActivity]);

  const writeBack = useCallback(
    ((rows: Parameters<WindowController["writeBack"]>[0]) => {
      if (!controller) throw new WindowControllerError("not-found");
      return controller.writeBack(rows);
    }) as DirectHistoryWindow["writeBack"],
    [controller],
  );

  return {
    controller,
    hasEarlier: ui.hasEarlier,
    isHistorical: ui.historical,
    loadFailed: ui.loadFailed,
    authoritativeTip: controller?.authoritativeTip ?? null,
    windowIds: controller ? controller.windowIds() : [],
    loadEarlier,
    goHistorical,
    restoreTip,
    writeBack,
  };
}


