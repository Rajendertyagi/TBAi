"use client";

import { useState, type FC } from "react";
import type { DataMessagePartProps } from "@assistant-ui/react";
import { Marker, MarkerContent } from "@/components/ui/marker";

/**
 * Renders TBAi's `data-tbai-compact` stream part: the outcome of a Direct context
 * compaction.
 *
 * ## Why a marker and not a card
 *
 * A compaction is not conversation. It has nothing to say, replies to nothing, and
 * the messages it replaced are still in the user's transcript. So it renders as a
 * labelled separator — `─── Context compacted ───` — which is what shadcn's
 * `Marker variant="separator"` is for. Its own docs use "Conversation compacted"
 * as the separator example.
 *
 * A card or a bubble would both be wrong: it would imply the compaction was
 * something the assistant said.
 *
 * ## Accessibility
 *
 * No `role`. The divider lines are decorative CSS pseudo-elements and the label is
 * ordinary content, so the marker needs no role — shadcn's docs explicitly warn
 * against `role="separator"` here, because that role takes its name from
 * `aria-label` and treats its contents as presentational, which would stop the
 * label being announced.
 *
 * When a running state is added, this must become `role="status"` with a spinner,
 * per the same docs.
 *
 * ## Status vocabulary
 *
 * Only the three outcomes the Direct command actually emits are handled. A status
 * this component does not recognise renders as `failed` rather than being dropped
 * or shown as a success — silently rendering nothing would hide a compaction the
 * user asked for.
 *
 * ## Why the summary is expandable rather than always shown
 *
 * A compaction replaces messages the user can still read in their own transcript, so
 * the divider is the only place its replacement is ever described. Showing the
 * summary inline by default would put a wall of text into the middle of every
 * conversation that has ever compacted, which trains people to stop reading it.
 *
 * Collapsed by default for a manual `/compact`, expanded by default for an automatic
 * or recovery compaction. One click reads either way.
 *
 * A divider with NO summary stays a plain separator with no affordance at all — there
 * is nothing to expand, and a control that reveals nothing is worse than no control.
 *
 * Expansion is component-local state, deliberately NOT keyed by `operationId` in a
 * module-level store. Keying it would make expansion survive a reload, at the cost
 * of unbounded module state that grows by one entry per compaction and is never
 * reclaimed. The summary is durable; whether you had it open is not worth that.
 */

/** The outcomes `src/routes/direct-compact-command.ts` emits. */
export type CompactOutcome = "compacted" | "skipped" | "failed";

/**
 * Who decided to compact.
 *
 * - `manual` — the user pressed `/compact`.
 * - `automatic` — the engine crossed its occupancy trigger mid-turn.
 * - `recovery` — the provider rejected the request and overflow recovery forced a
 *   rebuild.
 *
 * All three are the same durable compaction and the same divider; the origin is what
 * lets the transcript say *why*. "I asked for this", "the context filled up" and
 * "the provider ran out of room" are different things to read, and a divider that
 * said the same words for all three would be less true, not simpler.
 *
 * Absent means `manual`: a divider written before this field existed had no such
 * value, and treating it as manual is the honest reading of that row.
 */
export type CompactOrigin = "manual" | "automatic" | "recovery";

export type CompactData = {
  kind: "tbai-compact";
  version: 1;
  outcome: CompactOutcome;
  /** Raw compaction reason; never shown, but the fallback when status is unknown. */
  reason: string;
  /** Messages the compaction replaced. */
  spanLength: number;
  generation: number;
  origin?: CompactOrigin;
  /** The user's own narrowing words, when they gave any. Never rendered raw. */
  instructions?: string;
  /**
   * What compaction kept. Null on a skip or a failure, and absent on rows written
   * before the field existed — both mean there is nothing to reveal.
   */
  summary?: string | null;
};

/**
 * User-facing wording, following ZCode's semantics
 * (`packages/i18n/src/locales/en-US.ts:292` in the reference) rather than the
 * count-based phrasing the retired composer strip used.
 *
 * `skipped` deliberately reads as "up to date" — it is a successful no-op, not a
 * failure, and not something the user needs to act on.
 */
const COPY: Record<CompactOutcome, string> = {
  compacted: "Context compacted",
  skipped: "Context is up to date; no compaction needed",
  failed: "Context compaction failed",
};

/**
 * Non-manual compaction says so.
 *
 * A divider that reads "Context compacted" after a turn the user never asked to
 * compact is indistinguishable from one they did ask for. For `automatic` the
 * context filled up on its own; for `recovery` the provider rejected the request and
 * the conversation was shortened to get the turn through. Both happened TO the user,
 * so both say so.
 */
const COMPACTED_COPY: Record<CompactOrigin, string> = {
  manual: COPY.compacted,
  automatic: "Context compacted automatically",
  recovery: "Context compacted to recover from a context overflow",
};

/**
 * Only a manual command has a reader waiting for the result, so only a manual
 * compaction can be skipped or failed. The other two are defined rather than left
 * undefined so an unknown shape can never produce a blank label.
 */
const NON_MANUAL_COPY: Record<Exclude<CompactOrigin, "manual">, Record<CompactOutcome, string>> = {
  automatic: {
    compacted: COMPACTED_COPY.automatic,
    skipped: COPY.skipped,
    failed: COPY.failed,
  },
  recovery: {
    compacted: COMPACTED_COPY.recovery,
    skipped: COPY.skipped,
    failed: COPY.failed,
  },
};

const TONE: Record<CompactOutcome, string> = {
  // Terminal states are muted; a failure must still be distinguishable, so it
  // takes the warning token rather than more colour.
  compacted: "text-muted-foreground",
  skipped: "text-muted-foreground",
  failed: "text-warning",
};

function outcomeOf(value: unknown): CompactOutcome {
  return value === "compacted" || value === "skipped" || value === "failed" ? value : "failed";
}

/** Absent means manual: only the non-manual triggers write the field. */
function originOf(value: unknown): CompactOrigin {
  return value === "automatic" || value === "recovery" ? value : "manual";
}

/**
 * The summary to reveal, or null when there is nothing to reveal.
 *
 * Absent, null, and blank all collapse to null. A whitespace-only summary is not
 * worth an expand control, and rendering it would produce an empty box.
 */
function summaryOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** How many messages this compaction replaced, when it replaced any. */
function spanLabel(spanLength: number): string | null {
  if (!Number.isFinite(spanLength) || spanLength <= 0) return null;
  return `${spanLength} ${spanLength === 1 ? "message" : "messages"}`;
}

/**
 * The revealed summary.
 *
 * Exported for tests: it is the half of the divider that only exists after a click,
 * and this package has no DOM runner, so `renderToStaticMarkup` against the composed
 * element could never reach it.
 *
 * The message count lives HERE, not in the collapsed label. `compaction-divider.test.tsx`
 * deliberately asserts the label never carries it, and that guard is worth keeping: a
 * separator whose text varies in width per compaction is harder to scan past. Here it
 * is context for the summary rather than chrome, which is where it belongs.
 */
export const CompactSummaryPanel: FC<{ summary: string; spanLength: number }> = ({
  summary,
  spanLength,
}) => {
  const span = spanLabel(spanLength);
  return (
    <div className="mt-1.5 mb-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {span === null ? "Summary of the compacted turns" : `Summary of ${span} compacted turns`}
      </p>
      {/*
        `whitespace-pre-wrap` because a summary is prose with paragraph breaks;
        collapsing them would run it into one unreadable block. Selectable, so it can
        be copied into a new conversation — which is the practical reason to read it.
      */}
      <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">{summary}</p>
    </div>
  );
};

export const CompactionDivider: FC<DataMessagePartProps<CompactData>> = ({ data }) => {
  const outcome = outcomeOf(data?.outcome);
  const origin = originOf(data?.origin);
  const copy = origin === "manual" ? COPY : NON_MANUAL_COPY[origin];
  const summary = summaryOf(data?.summary);
  // Collapsed for a MANUAL compaction, expanded for the other two.
  //
  // A manual `/compact` is an answer to a question the reader asked, so the divider
  // label is the answer and one click is a fair price. The other two removed history
  // nobody asked to remove: `automatic` because the engine decided the context was
  // full, `recovery` because the provider rejected the request. Requiring a click to
  // discover that is the consent problem this panel exists to fix — so it starts open.
  //
  // Only a *terminal* non-manual compaction with a summary reaches this line, so there
  // is no case where an expanded panel would be showing a refusal.
  const [open, setOpen] = useState(origin !== "manual");

  // No summary: the separator exactly as it was before summaries existed. No button,
  // because a control that reveals nothing is worse than no control at all.
  if (summary === null) {
    return (
      <Marker variant="separator" className={TONE[outcome]}>
        <MarkerContent>{copy[outcome]}</MarkerContent>
      </Marker>
    );
  }

  return (
    <Marker variant="separator" className={TONE[outcome]}>
      <MarkerContent>
        {/*
          The whole label is the button, not a trailing chevron: a divider is a thin
          horizontal rule, so a small target at its end is hard to hit. The label text
          is unchanged from the non-expandable case — the affordance is the cursor and
          `aria-expanded`, not extra words.
        */}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="cursor-pointer rounded-xs text-left hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          {copy[outcome]}
        </button>
      </MarkerContent>
      {open ? <CompactSummaryPanel summary={summary} spanLength={data.spanLength} /> : null}
    </Marker>
  );
};