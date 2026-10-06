import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CompactSummaryPanel,
  CompactionDivider,
  type CompactData,
} from "./compaction-divider";

/**
 * The Direct `/compact` divider.
 *
 * Asserted against rendered markup because "compiles but paints nothing" is the
 * failure mode that has bitten this repo before (see `progress-stages.test.tsx`),
 * and because the whole point of this component is what the user SEES.
 *
 * The contract being pinned: a compaction is a labelled separator, it is never
 * conversation, and an unrecognised status must never read as a success.
 */

const compact = (outcome: CompactData["outcome"]): CompactData => ({
  kind: "tbai-compact",
  version: 1,
  outcome,
  reason: outcome === "compacted" ? "compacted" : `reason:${outcome}`,
  spanLength: 19,
  generation: 1,
});

const render = (data: unknown) =>
  renderToStaticMarkup(createElement(CompactionDivider as never, { data } as never));

describe("the compaction divider", () => {
  it("renders a labelled separator, not a card or a bubble", () => {
    const html = render(compact("compacted"));
    // shadcn Marker exposes its variant as a data attribute, which is what
    // produces the ruled lines either side of the label.
    expect(html).toContain('data-slot="marker"');
    expect(html).toContain('data-variant="separator"');
    expect(html).toContain("Context compacted");
  });

  it("reads `skipped` as up to date, not as a failure", () => {
    const html = render(compact("skipped"));
    expect(html).toContain("Context is up to date");
    // A no-op must not borrow the failure tone.
    expect(html).not.toContain("text-warning");
  });

  it("renders `failed` distinctly, using the warning token", () => {
    const html = render(compact("failed"));
    expect(html).toContain("Context compaction failed");
    expect(html).toContain("text-warning");
  });

  it("carries no role, so the label stays announced", () => {
    // shadcn's docs are explicit: `role="separator"` names itself from
    // `aria-label` and treats contents as presentational, which would silence the
    // label. Asserted so nobody adds it later "for accessibility".
    const html = render(compact("compacted"));
    expect(html).not.toContain('role="separator"');
  });

  it("treats an unknown outcome as failed rather than as success", () => {
    // Silently rendering nothing would hide a compaction the user asked for, and
    // rendering it as completed would be a lie.
    const html = render({ ...compact("compacted"), outcome: "totally-fine" });
    expect(html).toContain("Context compaction failed");
    expect(html).not.toContain("Context compacted");
  });

  it("does not leak the raw reason or the message count into the label", () => {
    const html = render(compact("failed"));
    expect(html).not.toContain("reason:failed");
    expect(html).not.toContain("19");
  });
});

const SUMMARY = "The user compared three storage engines and we settled on WAL.";

describe("revealing what compaction kept", () => {
  it("offers no control when there is no summary to reveal", () => {
    // A skip or a failure replaced nothing, and rows written before the field existed
    // have none. A control that opens onto nothing is worse than no control.
    for (const summary of [undefined, null, "", "   "] as const) {
      const html = render({ ...compact("compacted"), summary });
      expect(html).not.toContain("<button");
      expect(html).not.toContain("aria-expanded");
      // Still a plain, working separator.
      expect(html).toContain('data-variant="separator"');
      expect(html).toContain("Context compacted");
    }
  });

  it("keeps the collapsed label identical to the non-expandable one", () => {
    // The affordance is the cursor and `aria-expanded`, not extra words. Asserted so a
    // later "helpful" tweak cannot quietly widen every separator in the transcript.
    const plain = render(compact("compacted"));
    const expandable = render({ ...compact("compacted"), summary: SUMMARY });
    expect(expandable).toContain("Context compacted");
    expect(expandable).not.toContain("19");
    expect(plain).toContain('data-variant="separator"');
  });

  it("starts collapsed, so the summary is not dumped into the transcript", () => {
    // Server rendering always has `open === false`, which is exactly the state a user
    // first sees. Asserted because the alternative — a wall of summary text in every
    // compacted conversation — trains people to stop reading it.
    const html = render({ ...compact("compacted"), summary: SUMMARY });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("<button");
    expect(html).not.toContain(SUMMARY);
  });

  it("starts EXPANDED for a compaction the reader did not ask for", () => {
    // `automatic` and `recovery` removed history nobody requested. Requiring a click
    // to discover that is the consent problem this panel exists to fix, so both start
    // open. A manual `/compact` stays collapsed: the reader asked, the label is the
    // answer.
    for (const origin of ["automatic", "recovery"] as const) {
      const html = render({ ...compact("compacted"), origin, summary: SUMMARY });
      expect(`${origin}: ${html}`).toContain('aria-expanded="true"');
      // And the summary is actually visible, not merely flagged as expandable.
      expect(`${origin}: ${html}`).toContain(SUMMARY);
    }
    const manual = render({ ...compact("compacted"), origin: "manual", summary: SUMMARY });
    expect(manual).toContain('aria-expanded="false"');
    expect(manual).not.toContain(SUMMARY);
  });

  it("treats an absent origin as manual, so old rows are not force-opened", () => {
    // Pre-`origin` rows are manual compactions. Force-opening them would dump a wall
    // of text into every conversation compacted before this existed.
    const html = render({ ...compact("compacted"), summary: SUMMARY });
    expect(html).toContain('aria-expanded="false"');
  });

  it("uses a real button, so the divider is reachable by keyboard", () => {
    const html = render({ ...compact("compacted"), summary: SUMMARY });
    expect(html).toContain('type="button"');
  });

  it("shows the summary text once revealed, verbatim", () => {
    // Rendered directly: this panel only exists after a click, and there is no DOM
    // runner here to click with, so asserting on the composed element could never
    // reach it.
    const html = renderToStaticMarkup(
      createElement(CompactSummaryPanel, { summary: SUMMARY, spanLength: 19 }),
    );
    expect(html).toContain(SUMMARY);
  });

  it("names how much was replaced, in the panel rather than the label", () => {
    const many = renderToStaticMarkup(
      createElement(CompactSummaryPanel, { summary: SUMMARY, spanLength: 19 }),
    );
    expect(many).toContain("19 messages");

    // Singular, so the copy never reads "1 messages".
    const one = renderToStaticMarkup(
      createElement(CompactSummaryPanel, { summary: SUMMARY, spanLength: 1 }),
    );
    expect(one).toContain("1 message");
    expect(one).not.toContain("1 messages");
  });

  it("omits the count when nothing was replaced, rather than saying '0 messages'", () => {
    // An em dash or a bare header: "0 messages compacted" describes a compaction that
    // did not happen.
    const html = renderToStaticMarkup(
      createElement(CompactSummaryPanel, { summary: SUMMARY, spanLength: 0 }),
    );
    expect(html).toContain("Summary of the compacted turns");
    expect(html).not.toContain("0 messages");
  });

  it("preserves the summary's own line breaks", () => {
    // Summaries are prose with paragraphs; running them together is unreadable.
    const html = renderToStaticMarkup(
      createElement(CompactSummaryPanel, { summary: "First para.\n\nSecond para.", spanLength: 4 }),
    );
    expect(html).toContain("whitespace-pre-wrap");
  });
});