/**
 * P2 Direct — bounded history window.
 *
 * ## What this module is
 *
 * The deterministic core for managing loaded conversation history slices. It is a
 * **pure** module: it performs no I/O, reads no globals, and holds no React state.
 * Everything it needs arrives as arguments and everything it produces is a new
 * immutable value.
 *
 * ## Append-only model & DOM virtualization
 *
 * The loaded logical history buffer is append-only (and prepend-only when older pages
 * are requested). The performance and DOM footprint boundary is owned by DOM
 * virtualization (`VirtualizedTranscript.tsx`), not data eviction. Obsolete byte/message
 * eviction has been retired: loading an earlier page does not discard the live tail,
 * and navigating does not drop loaded messages.
 *
 * Semantic authority remains with P1' (`getHeadChain`), which reconstructs conversations
 * by walking parent links server-side.
 */

/**
 * How the window is moving.
 *
 * - `older` — the user loaded older history (prepended).
 * - `newer` — the user loaded newer history (appended).
 * - `explicit` — the user jumped somewhere specific (branch switch, historical jump).
 */
export type NavigationDirection = "older" | "newer" | "explicit";

/**
 * The operational state machine.
 *
 * `streaming` and `approval` are observed states from the runtime.
 */
export type WindowState =
  | "stable"
  | "loading-older"
  | "loading-newer"
  | "repositioning"
  | "committing"
  | "streaming"
  | "approval";

/** A position in the transcript: a message plus a pixel offset within it. */
export type ViewportAnchor = {
  readonly messageId: string;
  readonly offset: number;
};

/** Visible and protected region boundaries. */
export type ProtectedRegion = {
  readonly active: {
    readonly top: ViewportAnchor | null;
    readonly bottom: ViewportAnchor | null;
  };
  readonly protected: {
    readonly top: ViewportAnchor | null;
    readonly bottom: ViewportAnchor | null;
  };
};

/** One message as the window layer sees it. Content is opaque. */
export type WindowMessage = {
  readonly id: string;
  readonly parentId: string | null;
  readonly format: string;
  readonly content: unknown;
};

/**
 * Everything the backend answers for a window request.
 */
export type WindowSlice = {
  /** Contiguous run on the selected chain, oldest-first. */
  readonly messages: readonly WindowMessage[];
  /** Id of the chain message immediately before messages[0], or null at root. */
  readonly anchorBefore: string | null;
  /** Id of the chain message immediately after the last, or null at tip. */
  readonly anchorAfter: string | null;
  readonly complete: boolean;
};

/** Byte measurement over the stored representation. */
export type WindowSizer = (message: WindowMessage) => number;

const encoder = new TextEncoder();

/** Default: UTF-8 byte length of stored record's variable fields. */
export const defaultWindowSizer: WindowSizer = (message) =>
  encoder.encode(message.format).byteLength +
  encoder.encode(JSON.stringify(message.content ?? null) ?? "null").byteLength;

/** Immutable window state. */
export type HistoryWindowState = {
  readonly state: WindowState;
  /** Current window, oldest-first, contiguous on the selected chain. */
  readonly window: readonly WindowMessage[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly protectedRegion: ProtectedRegion;
  readonly overscan: number;
};

/**
 * Paging depth hint. This is how many MESSAGES one page requests, not a cap on
 * what may be held: the buffer is append-only (P2 REBASE), so older messages are
 * never evicted from it. What stays bounded is the DOM, and virtualization is
 * what bounds that.
 */
export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_OVERSCAN = 20;

export function createInitialWindowState(options?: {
  readonly pageSize?: number;
  readonly overscan?: number;
}): HistoryWindowState {
  return {
    state: "stable",
    window: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
    protectedRegion: {
      active: { top: null, bottom: null },
      protected: { top: null, bottom: null },
    },
    overscan: options?.overscan ?? DEFAULT_OVERSCAN,
  };
}

/** Runtime activity observed from the live conversation. */
export type RuntimeActivity = {
  readonly isStreaming: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingQuestion: boolean;
};

export const IDLE_RUNTIME: RuntimeActivity = {
  isStreaming: false,
  hasPendingApproval: false,
  hasPendingQuestion: false,
};

export function runtimeStateIsBusy(activity: RuntimeActivity): boolean {
  return activity.isStreaming || activity.hasPendingApproval || activity.hasPendingQuestion;
}

export function stateForActivity(activity: RuntimeActivity): WindowState {
  if (activity.isStreaming) return "streaming";
  if (activity.hasPendingApproval || activity.hasPendingQuestion) return "approval";
  return "stable";
}

function totalBytes(messages: readonly WindowMessage[], sizer: WindowSizer): number {
  let sum = 0;
  for (const message of messages) sum += sizer(message);
  return sum;
}

export function totalWindowBytes(
  messages: readonly WindowMessage[],
  sizer: WindowSizer = defaultWindowSizer,
): number {
  return totalBytes(messages, sizer);
}

export function indexOfMessage(
  messages: readonly WindowMessage[],
  messageId: string | null,
): number {
  if (messageId === null) return -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].id === messageId) return i;
  }
  return -1;
}

/**
 * Builds a contiguous candidate window from an incoming slice and the existing window.
 *
 * Replaces the window's overlap with the incoming slice to maintain idempotence,
 * while preserving parent-link ordering.
 */
export function buildCandidateWindow(
  current: readonly WindowMessage[],
  incoming: readonly WindowMessage[],
  direction: NavigationDirection,
): readonly WindowMessage[] {
  if (incoming.length === 0) return current;
  if (current.length === 0) return direction === "explicit" ? [...incoming] : current;

  const currentIndex = new Map<string, number>();
  for (let i = 0; i < current.length; i += 1) currentIndex.set(current[i].id, i);

  let firstOverlap = -1;
  for (let i = 0; i < incoming.length; i += 1) {
    if (currentIndex.has(incoming[i].id)) {
      firstOverlap = i;
      break;
    }
  }

  if (firstOverlap < 0) {
    // No shared anchor: explicit jump relocates; incremental keeps current window.
    return direction === "explicit" ? [...incoming] : current;
  }

  const offset = currentIndex.get(incoming[firstOverlap].id)! - firstOverlap;
  const start = Math.min(0, offset);
  const end = Math.max(current.length - 1, offset + incoming.length - 1);

  const merged: WindowMessage[] = [];
  for (let i = start; i <= end; i += 1) {
    if (i >= 0 && i < current.length) {
      merged.push(current[i]);
      continue;
    }
    const fromIncoming = i - offset;
    if (fromIncoming >= 0 && fromIncoming < incoming.length) {
      merged.push(incoming[fromIncoming]);
    }
  }
  return merged;
}

/**
 * Derives the anchor message id for a paging request.
 */
export function requestAnchorFor(
  window: readonly WindowMessage[],
  direction: "older" | "newer",
): string | null {
  if (window.length === 0) return null;
  return direction === "older" ? window[0].id : window[window.length - 1].id;
}

/**
 * Commits a candidate window in the append-only model (no data eviction).
 */
export function commitWindow(
  previous: HistoryWindowState,
  candidate: readonly WindowMessage[],
  boundaries: { readonly hasMoreBefore: boolean; readonly hasMoreAfter: boolean },
  active?: ProtectedRegion["active"],
  _direction?: NavigationDirection,
  activity: RuntimeActivity = IDLE_RUNTIME,
  _sizer: WindowSizer = defaultWindowSizer,
): HistoryWindowState {
  return {
    ...previous,
    state: stateForActivity(activity),
    window: candidate,
    hasMoreBefore: boundaries.hasMoreBefore,
    hasMoreAfter: boundaries.hasMoreAfter,
    protectedRegion: active
      ? { active, protected: { top: null, bottom: null } }
      : previous.protectedRegion,
  };
}

export type WindowInvariantReport = {
  /**
   * Every INTERIOR link in the window names the id immediately before it.
   *
   * The window's first message is deliberately excluded: on a bounded page its
   * real parent lies outside the window, so requiring it to resolve here would
   * reject every legitimate page.
   */
  readonly contiguous: boolean;
  /** True when every reported invariant held. Never a constant. */
  readonly satisfied: boolean;
};

/**
 * Checks the one window invariant that still has meaning: contiguity along the
 * parent chain.
 *
 * ## Why this reports only this
 *
 * It previously also returned `protectedContained`, `countBounded` and
 * `bytesBounded` — all hardcoded `true`, because the byte and count ceilings
 * they named were removed with data eviction, and the protected region stopped
 * being computed when it stopped gating anything. `chainOrdered` was a second
 * name for `contiguous`. A report whose fields are constants cannot be told apart
 * from a check that passed, so those fields are gone rather than left to report
 * success they never earned.
 *
 * ## What it does NOT check
 *
 * It does not validate the page the backend sent — `WindowController#commit`
 * fails closed on the server's own `contiguous` flag before this runs. This
 * checks the MERGED window, which no other layer inspects: a page that is
 * internally sound can still fail to line up with the window already held
 * (branch divergence, a stale overlap), and `buildCandidateWindow` aligns by
 * index offset rather than by verifying each join.
 */
export function checkWindowInvariants(state: HistoryWindowState): WindowInvariantReport {
  let contiguous = true;
  for (let i = 1; i < state.window.length; i += 1) {
    if (state.window[i].parentId !== state.window[i - 1].id) {
      contiguous = false;
      break;
    }
  }

  return { contiguous, satisfied: contiguous };
}
