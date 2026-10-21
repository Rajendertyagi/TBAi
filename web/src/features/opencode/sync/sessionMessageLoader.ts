/**
 * The history loader: reading the transcript's pages, and committing them.
 *
 * ## WHAT THIS OWNS
 *
 * The **mechanics of the history read** - paging the server's history reader,
 * and turning the result into the domain's history projection - and the
 * **commit** of that projection.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **Domain state.** The committed messages belong to the controller's
 *   reducer; the loader dispatches the commit and holds nothing.
 * - **The event buffer.** Events that arrive while a read is in flight are
 *   held by the event pipeline, and the controller decides when they are
 *   replayed.
 * - **The merge rule.** The loader transports the ids the commit reconciles
 *   against - which messages the client held, and which a live event touched -
 *   and the reducer decides what those ids mean.
 *
 * ## WHY THE COMMIT IS HERE AND NOT IN THE CALLER
 *
 * Committing a history projection is two things that always happen together:
 * project the snapshot, and dispatch it as one `history_loaded` action. Doing
 * that in one place is what makes the merge inputs a property of the commit
 * rather than of each call site.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving: the same read, the same projection, the same dispatch. Phase 4
 * replaced the outright-replace commit with the reconciling one, which is why
 * a permission list no longer triggers a reprojection of the transcript.
 */

import type { OpenCodeV2Generation } from "../v2Client";
import { loadV2History, projectV2History } from "../v2History";
import type { V2HistoryMerge, V2HistorySnapshot, V2ThreadAction } from "../v2Types";

/** What the loader needs from the controller. */
export interface SessionMessageLoaderHost {
  /** Dispatches a domain action. */
  dispatch(action: V2ThreadAction): void;
}

/** The loader's surface. */
export interface SessionMessageLoader {
  /**
   * Reads the transcript's history.
   *
   * @param generation - The generation whose history reader to read.
   * @param signal - The signal that aborts the read, when there is one.
   * @returns The history snapshot.
   */
  read(generation: OpenCodeV2Generation, signal?: AbortSignal): Promise<V2HistorySnapshot>;
  /**
   * Projects a snapshot and commits it.
   *
   * @param snapshot - The snapshot to commit.
   * @param merge - The ids the commit reconciles against.
   */
  commit(snapshot: V2HistorySnapshot, merge: V2HistoryMerge): void;
}

/**
 * Creates the history loader.
 *
 * @param host - What the loader needs from the controller.
 * @returns The loader.
 */
export function createSessionMessageLoader(host: SessionMessageLoaderHost): SessionMessageLoader {
  async function read(
    generation: OpenCodeV2Generation,
    signal?: AbortSignal,
  ): Promise<V2HistorySnapshot> {
    return loadV2History(generation.history, signal ? { signal } : {});
  }

  function commit(snapshot: V2HistorySnapshot, merge: V2HistoryMerge): void {
    const projection = projectV2History(snapshot);
    host.dispatch({
      type: "history_loaded",
      messages: projection.messages,
      messageOrder: projection.messageOrder,
      pages: projection.pages,
      merge,
    });
  }

  return { read, commit };
}
