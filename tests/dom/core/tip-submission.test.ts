/**
 * SPIKE — CONTRACT AUDIT, Question 1: TIP / SUBMISSION SEMANTICS.
 * TEMPORARY, REMOVABLE.
 *
 * The authoritative chain is m1..m500. A bounded window shows part of it.
 * The user sends a message. This records, by EXECUTION, what ends up in each
 * layer and whether the semantic submission head survives.
 *
 * Layers recorded:
 *   A. the assistant-ui repository (what the viewport would render)
 *   B. `chat.messages`        (the AI SDK Chat — the submission source)
 *   C. the transport payload  (what the model is actually asked)
 *   D. what P1' reconstructs (what the server would send to the model)
 *   E. the authoritative head
 */

import { describe, expect, it } from "bun:test";
import {
  aiMessages,
  chainFromTo,
  createAudit,
  missingFrom,
  p1pReconstruct,
  type Submission,
} from "../../helpers/dom/audit-harness.ts";

const AUTHORITATIVE = chainFromTo(1, 500);
const HEAD_CHAIN = { messages: AUTHORITATIVE.map((id) => ({ id })), complete: true };

type LayerRecord = {
  readonly visible: readonly string[];
  readonly head: string | null;
  readonly chat: readonly string[];
  readonly submitted: readonly string[];
  readonly p1pApplied: boolean;
  readonly p1pEffective: readonly string[];
  readonly missingFromAuthoritative: readonly string[];
};

/** Send one user message exactly as the composer does (at the semantic head). */
async function send(h: ReturnType<typeof createAudit>, text: string): Promise<void> {
  await h.send(text);
}

function record(h: ReturnType<typeof createAudit>): LayerRecord {
  const submitted = h.submissions.at(-1);
  const submittedIds: readonly string[] = submitted?.ids ?? [];
  // `p1pReconstruct` reads `message.id`, so it takes message-shaped input.
  const p1p = p1pReconstruct(HEAD_CHAIN, submittedIds.map((id) => ({ id })));
  return {
    visible: h.visibleIds(),
    head: h.headId(),
    chat: h.chatIds(),
    submitted: submittedIds,
    p1pApplied: p1p.applied,
    p1pEffective: p1p.effective,
    missingFromAuthoritative: missingFrom(AUTHORITATIVE, p1p.effective),
  };
}

function show(label: string, r: LayerRecord): void {
  const first = (xs: readonly string[]) =>
    xs.length === 0 ? "(none)" : `${xs[0]}..${xs[xs.length - 1]} (${xs.length})`;
  console.log(`\n=== ${label} ===`);
  console.log(`  A repository visible : ${first(r.visible)}`);
  console.log(`  E repository head    : ${r.head}`);
  console.log(`  B chat.messages      : ${first(r.chat)}`);
  console.log(`  C transport payload  : ${first(r.submitted)}`);
  console.log(`  D P1' applied        : ${r.p1pApplied}`);
  console.log(`  D P1' effective      : ${first(r.p1pEffective)}`);
  console.log(
    `  !! missing from chain : ${r.missingFromAuthoritative.length}` +
      (r.missingFromAuthoritative.length > 0
        ? ` -> ${r.missingFromAuthoritative.slice(0, 6).join(",")}...`
        : ""),
  );
}

describe("Q1 — tip containment decides the submission head", () => {
  it("a tip-containing window submits the full authoritative chain", async () => {
    const h = createAudit({
      authoritative: AUTHORITATIVE,
      window: chainFromTo(451, 500),
    });

    // Before the send: the window ends at the tip.
    expect(h.visibleIds().at(-1)).toBe("m500");
    expect(h.headId()).toBe("m500");

    await send(h, "question");
    const r = record(h);
    show("Q1.1 tip-containing window [m451..m500] + send", r);

    // The submission is the window plus the new message — 51 messages.
    expect(r.submitted.length).toBe(51);
    expect(r.submitted[0]).toBe("m451");
    expect(r.submitted.at(-1)).not.toBe("m500"); // new message id

    // P1' restores the prefix, so the model sees the WHOLE chain.
    expect(r.p1pApplied).toBe(true);
    expect(r.p1pEffective.length).toBe(51 + 450);
    expect(r.missingFromAuthoritative).toEqual([]);

    h.dispose();
  });

  it("a tip-EXCLUDING window silently drops the rest of the chain", async () => {
    const h = createAudit({
      authoritative: AUTHORITATIVE,
      window: chainFromTo(351, 400),
    });

    // The window does NOT contain the authoritative tip.
    expect(h.visibleIds().at(-1)).toBe("m400");
    expect(h.headId()).toBe("m400");
    expect(h.authoritativeTip).toBe("m500");
    expect(h.visibleIds()).not.toContain("m500");

    await send(h, "question");
    const r = record(h);
    show("Q1.2 tip-EXCLUDING window [m351..m400] + send", r);

    // The submission is only the window plus the new message.
    expect(r.submitted[0]).toBe("m351");
    expect(r.submitted.length).toBe(51);

    // P1' restores m1..m350 and NOTHING after the window.
    expect(r.p1pApplied).toBe(true);
    expect(r.p1pEffective[0]).toBe("m1");

    // 100 messages of real conversation (m401..m500) are silently absent from
    // what the model is asked. No error was raised anywhere.
    expect(r.missingFromAuthoritative.length).toBe(100);
    expect(r.missingFromAuthoritative).toContain("m500");

    h.dispose();
  });

  it("an append naming the true tip is routed to onEdit, not onNew", async () => {
    const h = createAudit({
      authoritative: AUTHORITATIVE,
      window: chainFromTo(351, 400),
    });

    // The host tries to submit as if the tip were the parent.
    let thrown: string | null = null;
    try {
      await h.runtime.append({
        role: "user",
        parentId: "m500",
        content: [{ type: "text", text: "from the tip" }],
      } as never);
      await new Promise((r) => setTimeout(r, 30));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    console.log("\n=== Q1.3 append with parentId = true tip m500 while window ends m400 ===");
    console.log("  thrown:", thrown ?? "(no error)");
    console.log("  transport submissions:", h.submissions.length);
    console.log("  chat.messages now:", h.chatIds().slice(0, 3).join(","), "...");

    // `append` classifies sourceId/parentId !== last-visible as an EDIT
    // (external-store-thread-runtime-core.js:431), so the submission goes
    // through `sliceMessagesUntil(chat.messages, "m500")` and throws.
    expect(thrown).toContain("m500");
    expect(thrown).toContain("not found in AI SDK messages");
    expect(h.submissions.length).toBe(0);

    h.dispose();
  });

  it("navigating to a historical window does not itself submit or throw", async () => {
    const h = createAudit({
      authoritative: AUTHORITATIVE,
      window: chainFromTo(451, 500),
    });

    // Pure navigation: no send.
    h.setWindow(chainFromTo(350, 400));

    console.log("\n=== Q1.4 navigation-only, no send ===");
    console.log("  visible:", `${h.visibleIds()[0]}..${h.visibleIds().at(-1)}`);
    console.log("  head:", h.headId());
    console.log("  authoritative tip still known to host:", h.authoritativeTip);
    console.log("  transport submissions:", h.submissions.length);

    expect(h.submissions.length).toBe(0);
    expect(h.headId()).toBe("m400");
    expect(h.authoritativeTip).toBe("m500");

    h.dispose();
  });

  it("restoring the tip window restores the submission head", async () => {
    const h = createAudit({
      authoritative: AUTHORITATIVE,
      window: chainFromTo(351, 400),
    });
    expect(h.headId()).toBe("m400");

    h.setWindow(chainFromTo(451, 500));
    expect(h.headId()).toBe("m500");

    await send(h, "after restore");
    const r = record(h);
    show("Q1.5 restore tip window, then send", r);

    expect(r.missingFromAuthoritative).toEqual([]);
    h.dispose();
  });

  it("records the submission trigger so regenerate is distinguishable", async () => {
    const h = createAudit({
      authoritative: AUTHORITATIVE,
      window: chainFromTo(451, 500),
    });
    await send(h, "q");

    const only: Submission | undefined = h.submissions.at(-1);
    console.log("\n=== Q1.6 trigger ===");
    console.log("  trigger:", only?.trigger);

    expect(only?.trigger).toBe("submit-message");
    h.dispose();
  });
});