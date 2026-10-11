/**
 * SPIKE — CONTRACT AUDIT, Question 2: EDIT / REGENERATE OUTSIDE THE WINDOW.
 * TEMPORARY, REMOVABLE.
 *
 * Authoritative chain m1..m500; visible window m451..m500. Every case records
 * the requested parent, the visible repository, the AI SDK Chat contents, the
 * transport payload, the resulting head, and the exact error when it fails.
 *
 * The point is NOT to make these pass. It is to establish which operations are
 * structurally available and which are not, so the P2 contract is written
 * against measured capability rather than against a desired UX.
 */

import { describe, expect, it } from "bun:test";
import { chainFromTo, createAudit } from "../../helpers/dom/audit-harness.ts";

const AUTHORITATIVE = chainFromTo(1, 500);
const WINDOW = chainFromTo(451, 500);

type CaseRecord = {
  readonly label: string;
  readonly requestedParent: string | null;
  readonly inWindow: boolean;
  readonly visibleBefore: number;
  readonly headBefore: string | null;
  readonly headAfter: string | null;
  readonly chatAfter: readonly string[];
  readonly submissionIds: readonly string[];
  readonly ok: boolean;
  readonly error: string | null;
};

async function runEdit(
  h: ReturnType<typeof createAudit>,
  label: string,
  parentId: string,
): Promise<CaseRecord> {
  const visibleBefore = h.visibleIds();
  const headBefore = h.headId();
  let error: string | null = null;
  const before = h.submissions.length;
  try {
    await h.appendAt(parentId, `edited ${parentId}`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    label,
    requestedParent: parentId,
    inWindow: visibleBefore.includes(parentId),
    visibleBefore: visibleBefore.length,
    headBefore,
    headAfter: h.headId(),
    chatAfter: h.chatIds(),
    submissionIds: h.submissions.length > before ? (h.submissions.at(-1)?.ids ?? []) : [],
    ok: error === null,
    error,
  };
}

async function runRegenerate(
  h: ReturnType<typeof createAudit>,
  label: string,
  parentId: string,
): Promise<CaseRecord> {
  const visibleBefore = h.visibleIds();
  const headBefore = h.headId();
  let error: string | null = null;
  const before = h.submissions.length;
  try {
    // `startRun({parentId})` is the regenerate/reload entry point; it routes to
    // the store's `onReload`, which is where `sliceMessagesUntil` lives.
    await h.runtime.startRun({ parentId } as never);
    await new Promise((r) => setTimeout(r, 40));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    label,
    requestedParent: parentId,
    inWindow: visibleBefore.includes(parentId),
    visibleBefore: visibleBefore.length,
    headBefore,
    headAfter: h.headId(),
    chatAfter: h.chatIds(),
    submissionIds: h.submissions.length > before ? (h.submissions.at(-1)?.ids ?? []) : [],
    ok: error === null,
    error,
  };
}

function report(r: CaseRecord): void {
  console.log(`\n--- ${r.label} (parent ${r.requestedParent}) ---`);
  console.log(`  in window        : ${r.inWindow}`);
  console.log(`  head before/after: ${r.headBefore} -> ${r.headAfter}`);
  console.log(`  chat.messages    : ${r.chatAfter.length}`);
  console.log(`  submission       : ${r.submissionIds.length}`);
  console.log(`  outcome          : ${r.ok ? "OK" : `THREW -> ${r.error}`}`);
}

describe("Q2 — edit/regenerate availability against a bounded window", () => {
  it("edits a message inside the window succeed and keep the tip", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    const r = await runEdit(h, "A. edit m490", "m490");
    report(r);

    expect(r.inWindow).toBe(true);
    expect(r.ok).toBe(true);
    // Editing truncates at the parent, so the visible tail changes.
    expect(r.chatAfter.length).toBeLessThan(WINDOW.length + 1);
    h.dispose();
  });

  it("regenerates a message inside the window succeed", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    const r = await runRegenerate(h, "B. regenerate m490", "m490");
    report(r);

    expect(r.inWindow).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.submissionIds.length).toBeGreaterThan(0);
    h.dispose();
  });

  it("edit at the window's OLDEST edge succeeds", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    const r = await runEdit(h, "C. edit m451 (window floor)", "m451");
    report(r);

    expect(r.inWindow).toBe(true);
    expect(r.ok).toBe(true);
    h.dispose();
  });

  it("regenerate at the window's OLDEST edge succeeds", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    const r = await runRegenerate(h, "D. regenerate m451 (window floor)", "m451");
    report(r);

    expect(r.inWindow).toBe(true);
    expect(r.ok).toBe(true);
    h.dispose();
  });

  it("edit OUTSIDE the window throws the not-found error", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    const r = await runEdit(h, "E. edit m400 (outside window)", "m400");
    report(r);

    expect(r.inWindow).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Message "m400" not found in AI SDK messages');
    // Nothing was submitted and the conversation is untouched.
    expect(r.submissionIds).toEqual([]);
    expect(r.headAfter).toBe("m500");
    h.dispose();
  });

  it("regenerate OUTSIDE the window throws the not-found error", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    const r = await runRegenerate(h, "F. regenerate m400 (outside window)", "m400");
    report(r);

    expect(r.inWindow).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Message "m400" not found in AI SDK messages');
    expect(r.submissionIds).toEqual([]);
    expect(r.headAfter).toBe("m500");
    h.dispose();
  });

  it("branching from outside the window throws the same error", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });
    let error: string | null = null;
    try {
      // A branch is an append naming a non-head parent — the same code path.
      await h.appendAt("m400", "branched from m400");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    console.log("\n--- G. branch from m400 (outside window) ---");
    console.log("  outcome:", error ?? "OK");
    console.log("  head:", h.headId());
    console.log("  chat.messages:", h.chatIds().length);

    expect(error).toContain('Message "m400" not found in AI SDK messages');
    h.dispose();
  });

  it("switching back to the tip is a pure window replacement", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: chainFromTo(451, 500) });

    // Move away, then back.
    h.setWindow(chainFromTo(351, 400));
    expect(h.headId()).toBe("m400");
    h.setWindow(chainFromTo(451, 500));
    const r = await runEdit(h, "H. edit m500 after returning to tip", "m500");
    report(r);

    expect(r.headBefore).toBe("m500");
    expect(r.ok).toBe(true);
    h.dispose();
  });

  it("records that 'load then edit' is possible but is a host responsibility", async () => {
    // The only structurally available path to editing an out-of-window message
    // is to widen the Chat array first. Measure that it works when the host does
    // it, so the contract can require it rather than assume it.
    const h = createAudit({ authoritative: AUTHORITATIVE, window: WINDOW });

    const before = await runEdit(h, "  (first attempt, out of window)", "m400");
    expect(before.ok).toBe(false);

    // The host widens the window to include the target.
    h.setWindow(chainFromTo(395, 500));
    const after = await runEdit(h, "  (after host widened the window)", "m400");
    report(after);

    expect(h.visibleIds()).toContain("m400");
    expect(after.ok).toBe(true);
    h.dispose();
  });
});
