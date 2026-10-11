/**
 * P2 Direct History Window — the production window controller.
 *
 * SQLite is authoritative. This controller turns that authority into the bounded,
 * branch-aware semantic window assistant-ui renders, and routes every persisted
 * write-back through `windowWriteBack.deriveWriteBack`.
 *
 * ## What it owns
 *
 * - the window STATE (`HistoryWindowState` from the frozen core — never a
 *   parallel model),
 * - navigation (`loadOlder` / `loadNewer` / `goHistorical` / `restoreTip`),
 * - out-of-window target resolution for edit/regenerate/branch,
 * - the `messageRepository` seed handed to `useChatRuntime`
 *   (`MessageFormatRepository`: `{ messages: [{ message, parentId }], headId }`),
 * - the historical gate (non-submittable, non-mutating).
 *
 * ## What it deliberately does NOT own
 *
 * conversion, binding, repository semantics and the streaming protocol. Upstream
 * converts the seed through its own converter, so the `symbolInnerMessage`
 * binding survives into the runtime's messages — which is exactly what write-back
 * needs. This controller never rebuilds messages: it only pairs PERSISTED parent
 * ids with the stored messages it was given.
 */

import {
  buildCandidateWindow,
  checkWindowInvariants,
  commitWindow,
  createInitialWindowState,
  IDLE_RUNTIME,
  type HistoryWindowState,
  type NavigationDirection,
  type ProtectedRegion,
  type RuntimeActivity,
  type WindowMessage,
} from "./historyWindow";
import { deriveWriteBack, WriteBackAmbiguityError, type BoundRow } from "./windowWriteBack";

/**
 * One persisted row as the window API returns it: the stored envelope plus the
 * same row decoded into the runtime's message shape.
 *
 * `parentId` is the PERSISTED link and stays that way for every interior row —
 * that is the branch authority. Only the bounded window root is clipped to
 * `null` (see `withBoundedRoot`), because its real parent lies outside the
 * window.
 */
export type PersistedRow = {
  readonly id: string;
  readonly parentId: string | null;
  readonly format: string;
  readonly content: unknown;
  /** The format adapter's decode of the same row: the message upstream converts. */
  readonly message: unknown;
};

/**
 * The backend's bounded-window response.
 *
 * `contiguous` is the fail-closed signal, NOT `complete`: a bounded page is
 * expected to stop short of the root, so `complete` is legitimately false for
 * every initial load of a long thread. `contiguous` is what proves the slice
 * itself is sound.
 */
export type WindowSliceResponse = {
  readonly messages: readonly PersistedRow[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly contiguous: boolean;
  /** Present for the P1' contract; not an integrity signal for the window. */
  readonly complete?: boolean;
};

export type WindowRequest = {
  readonly direction: "older" | "newer";
  readonly anchorId: string | null;
  readonly limit: number;
};

export type WindowFetcher = (request: WindowRequest) => Promise<WindowSliceResponse>;

/**
 * The seed shape `useChatRuntime`/`useChatThread` forwards to
 * `useAISDKRuntime` as `messageRepository`. Public option, upstream conversion.
 */
export type MessageRepositorySeed = {
  readonly messages: ReadonlyArray<{ readonly message: unknown; readonly parentId: string | null }>;
  readonly headId: string | null;
};

/** Why a window could not be established. Never message text. */
export type WindowFailure =
  | "incomplete-slice"
  | "not-found"
  | "write-back-unrecoverable";

export class WindowControllerError extends Error {
  readonly failure: WindowFailure;
  readonly ids: readonly string[];

  constructor(failure: WindowFailure, ids: readonly string[] = [], detail?: string) {
    super(`History window: ${failure}${detail ? ` (${detail})` : ""}`);
    this.name = "WindowControllerError";
    this.failure = failure;
    this.ids = ids;
  }
}

/** The viewport's measured region; supplied by the caller because layout is the DOM's. */
export type Anchors = ProtectedRegion["active"];

export type WindowControllerOptions = {
  readonly fetchWindow: WindowFetcher;
  /**
   * PAGE size: how many messages one load asks the backend for. It is NOT a
   * ceiling on the loaded buffer.
   *
   * The buffer is append-only (see the P2 rebase in docs/decisions.md), so this
   * number bounds a request, never what the user may hold. The old model used it
   * as a data limit and evicted on every commit, which made a prepended page
   * delete itself: it was not in the protected region measured before the
   * commit. The bound that matters now is the MOUNTED row count, which
   * virtualization owns.
   */
  readonly limit?: number;
  readonly overscan?: number;
  /**
   * Measured active region, used for position restoration and window
   * invariants. It no longer gates eviction — the buffer is append-only — so it
   * is accepted but never required.
   */
  readonly anchors?: () => Anchors;
  /** Runtime activity, so a navigation can refuse to commit while a run holds state. */
  readonly activity?: () => RuntimeActivity;
};

/** Rows handed to the frozen core: the persisted envelope, with real parentage. */
const toWindowMessages = (rows: readonly PersistedRow[]): WindowMessage[] =>
  rows.map((r) => ({ id: r.id, parentId: r.parentId, format: r.format, content: r.content }));

/**
 * Clip the bounded root: the window's first message has no parent INSIDE the
 * window, so its link is `null`. Interior links stay PERSISTED — that is what
 * keeps branch authority and hole detection honest.
 */
const withBoundedRoot = (
  rows: readonly PersistedRow[],
): Array<{ message: unknown; parentId: string | null }> =>
  rows.map((row, index) => ({ message: row.message, parentId: index === 0 ? null : row.parentId }));

export class WindowController {
  readonly #fetchWindow: WindowFetcher;
  readonly #limit: number;
  readonly #overscan: number;
  readonly #anchors: () => Anchors;
  readonly #activity: () => RuntimeActivity;

  #state: HistoryWindowState;
  /** Rows of the committed window, in render order, paired with persisted parents. */
  #rows: readonly PersistedRow[] = [];
  /** Decoded message per persisted id, so a commit can rebuild `#rows`. */
  #messagesById = new Map<string, PersistedRow>();
  #historical = false;
  #authoritativeTip: string | null = null;

  constructor(options: WindowControllerOptions) {
    this.#fetchWindow = options.fetchWindow;
    this.#limit = options.limit ?? 100;
    this.#overscan = options.overscan ?? 20;
    this.#anchors = options.anchors ?? (() => ({ top: null, bottom: null }));
    this.#activity = options.activity ?? (() => IDLE_RUNTIME);
    // No data ceiling at all. The loaded buffer is append-only and nothing evicts
    // from it; bounding the DOM is virtualization's job. The old limits are gone
    // rather than set to Infinity, so no dead ceiling can be mistaken for policy.
    this.#state = createInitialWindowState({
      overscan: this.#overscan,
    });
  }

  /* ── reads ─────────────────────────────────────────────────────────────── */

  get state(): HistoryWindowState {
    return this.#state;
  }

  get historical(): boolean {
    return this.#historical;
  }

  /** Authoritative tip of the selected chain. Survives historical navigation. */
  get authoritativeTip(): string | null {
    return this.#authoritativeTip;
  }

  get hasMoreBefore(): boolean {
    return this.#state.hasMoreBefore;
  }

  get hasMoreAfter(): boolean {
    return this.#state.hasMoreAfter;
  }

  windowIds(): string[] {
    return this.#state.window.map((m) => m.id);
  }

  /** The committed window's persisted rows, in render order. */
  rows(): readonly PersistedRow[] {
    return this.#rows;
  }

  /** True when the window may be mutated or submitted from. */
  get isActive(): boolean {
    return !this.#historical;
  }

  /**
   * The bounded window as the public `messageRepository` seed. Upstream converts
   * these messages, so the write-back binding is created upstream and survives.
   */
  repositorySeed(): MessageRepositorySeed {
    return {
      messages: withBoundedRoot(this.#rows),
      headId: this.#rows.at(-1)?.id ?? null,
    };
  }

  /* ── commits ───────────────────────────────────────────────────────────── */

  async #commit(
    direction: NavigationDirection,
    request: Omit<WindowRequest, "limit">,
    options: { historical?: boolean; allowEmpty?: boolean } = {},
  ): Promise<void> {
    const slice = await this.#fetchWindow({ ...request, limit: this.#limit });

    // Fail-closed: a slice that cannot prove its own integrity must not replace
    // a valid window. `contiguous`, not `complete` — see `WindowSliceResponse`.
    if (!slice.contiguous) {
      throw new WindowControllerError("incomplete-slice", slice.messages.map((m) => m.id));
    }
    if (slice.messages.length === 0) {
      // Walking `newer` from the tip legitimately returns nothing: the caller is
      // already at the tip. That is not a failure and must not disturb the window
      // (idempotent restore). Everything else is a real miss.
      //
      // The same answer is legitimate for a conversation that holds NO messages
      // at all: an empty conversation is a successful load, not a failed one.
      // `loadTip` therefore allows it. Without this the initial load of an empty
      // conversation throws `not-found`, the history adapter classifies that as a
      // FAILED load, and failed-load recovery then retries a thread that had
      // nothing to fetch.
      if (options.allowEmpty) return;
      throw new WindowControllerError("not-found", request.anchorId ? [request.anchorId] : []);
    }

    const rows = slice.messages;
    const candidate = buildCandidateWindow(this.#state.window, toWindowMessages(rows), direction);

    // Fail-closed on the MERGED window, before any state is touched.
    //
    // `slice.contiguous` (above) is the backend's word about the page it just
    // sent. It says nothing about whether that page still lines up with the
    // window we ALREADY hold: `buildCandidateWindow` joins the two by index
    // offset from the first shared id, so a page whose overlap id still exists
    // but whose interior links now point elsewhere — a branch changed under a
    // stale window — merges into a window with a hole in it, and nothing
    // downstream inspects the result. The rendered transcript would silently
    // skip a message.
    //
    // The candidate is checked directly; committing first and inspecting
    // afterwards would still be safe (no state is assigned until below) but
    // would read as though the commit had already happened.
    if (!checkWindowInvariants({ ...this.#state, window: candidate }).satisfied) {
      throw new WindowControllerError("incomplete-slice", rows.map((m) => m.id));
    }

    const committed = commitWindow(
      this.#state,
      candidate,
      { hasMoreBefore: slice.hasMoreBefore, hasMoreAfter: slice.hasMoreAfter },
      this.#anchors(),
      direction,
      this.#activity(),
    );

    for (const row of rows) this.#messagesById.set(row.id, row);
    this.#state = committed;
    // `#rows` is rebuilt from the COMMITTED window, not from the fetched slice:
    // the slice is only the page that just arrived, while the committed window
    // is the whole window after prepending/appending/evicting. Reading the slice
    // here would drop everything already loaded on the first paging step.
    this.#rows = this.#state.window.flatMap((m) => {
      const stored = this.#messagesById.get(m.id);
      if (!stored) return [];
      return [{ id: m.id, parentId: m.parentId, format: m.format, content: m.content, message: stored.message }];
    });
    this.#historical = options.historical ?? this.#historical;
    if (!this.#historical) this.#authoritativeTip = rows.at(-1)?.id ?? this.#authoritativeTip;
  }

  /** A. Initial bounded active window: the authoritative tip run. */
  async loadTip(): Promise<void> {
    // `allowEmpty`: a conversation that holds no messages is a successful tip
    // load. See the empty-slice branch in #commit.
    await this.#commit("explicit", { direction: "older", anchorId: null }, { allowEmpty: true });
    this.#historical = false;
  }

  /**
   * Load one older page, widening the window downward.
   *
   * Paging back leaves the window away from the authoritative tip, so callers
   * normally mark it historical: that is the state which refuses submission, and
   * it is why `restoreTip` exists.
   */
  async loadOlder(options: { historical?: boolean } = {}): Promise<void> {
    const anchorId = this.#state.window[0]?.id ?? this.#authoritativeTip;
    if (anchorId === null) throw new WindowControllerError("not-found");
    await this.#commit("older", { direction: "older", anchorId }, { historical: options.historical });
  }

  /** Load the run back toward the tip. */
  async loadNewer(): Promise<void> {
    const anchorId = this.#state.window.at(-1)?.id ?? this.#authoritativeTip;
    if (anchorId === null) throw new WindowControllerError("not-found");
    await this.#commit("newer", { direction: "newer", anchorId });
    this.#historical = false;
  }

  /**
   * B. Historical navigation: an explicit, non-submittable, non-mutating window.
   *
   * The target is resolved from SQLite by walking `older` from the requested id,
   * so the window is that message's own branch run. It is never rebased onto the
   * active tip, and the authoritative tip is preserved for the restore.
   */
  async goHistorical(targetId: string): Promise<void> {
    await this.#commit("explicit", { direction: "older", anchorId: targetId }, { historical: true });
  }

  /** C. Restore the active tip window. */
  async restoreTip(): Promise<void> {
    if (this.#authoritativeTip === null) {
      await this.loadTip();
      return;
    }
    await this.#commit("newer", { direction: "newer", anchorId: this.#authoritativeTip }, { allowEmpty: true });
    this.#historical = false;
  }

  /**
   * Resolve an operation target that may lie OUTSIDE the current window.
   *
   * F/G/H: an edit, regenerate or branch target outside the window must be
   * located in SQLite and the window repositioned to it — never reported as
   * "not found" and never silently replaced by the current tip.
   *
   * Returns the persisted id so the caller can address the right message.
   */
  async resolveTarget(targetId: string): Promise<string> {
    if (this.#state.window.some((m) => m.id === targetId)) return targetId;
    const slice = await this.#fetchWindow({ direction: "older", anchorId: targetId, limit: this.#limit });
    // `contiguous`, not `complete`: the walk from a mid-conversation target is
    // expected to stop short of the root, so requiring `complete` would report
    // every reachable out-of-window target as missing.
    if (!slice.contiguous || slice.messages.length === 0) {
      throw new WindowControllerError("not-found", [targetId]);
    }
    if (!slice.messages.some((m) => m.id === targetId)) {
      // The walk did not contain the target: refuse rather than rebase.
      throw new WindowControllerError("not-found", [targetId]);
    }
    await this.#commit("explicit", { direction: "older", anchorId: targetId });
    return targetId;
  }

  /* ── write-back ────────────────────────────────────────────────────────── */

  /**
   * J. Persisted write-back for the runtime's binding-carrying messages.
   *
   * `rows` are the runtime's OWN messages (the ones upstream converted and
   * bound) paired with the parent row ids they render under. Repository export
   * objects are not accepted as a source: they carry no binding, and
   * `deriveWriteBack` fails closed rather than writing an empty window.
   *
   * @throws WindowControllerError("write-back-unrecoverable") on a missing
   * binding, a duplicate persisted id, or unresolvable parentage.
   */
  writeBack(runtimeRows: readonly BoundRow[]) {
    try {
      return deriveWriteBack(runtimeRows);
    } catch (e) {
      if (e instanceof WriteBackAmbiguityError) {
        throw new WindowControllerError("write-back-unrecoverable", e.ids, e.ambiguity);
      }
      throw e;
    }
  }
}
