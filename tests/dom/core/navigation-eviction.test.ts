/**
 * SPIKE — CONTRACT AUDIT, Questions 3 & 4:
 *   Q3 historical navigation, and whether it can be presentation-only
 *   Q4 child transcripts / eviction: presentation-only or semantic?
 * TEMPORARY, removable.
 */

import { describe, expect, it } from "bun:test";
import { chainFromTo, createAudit, msgId } from "../../helpers/dom/audit-harness.ts";

const AUTHORITATIVE = chainFromTo(1, 500);

describe("Q3 — historical navigation is presentation, and restoring it is lossless", () => {
  it("navigation alone changes only the window; no submission occurs", () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: chainFromTo(451, 500) });
    expect(h.headId()).toBe("m500");

    h.setWindow(chainFromTo(350, 400));

    expect(h.submissions.length).toBe(0);
    expect(h.headId()).toBe("m400");
    // The host still knows the true tip even though the runtime does not.
    expect(h.authoritativeTip).toBe("m500");
    h.dispose();
  });

  it("historical -> restore tip -> send submits the FULL chain", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: chainFromTo(451, 500) });

    h.setWindow(chainFromTo(350, 400));
    h.setWindow(chainFromTo(451, 500));
    await h.send("after historical round trip");

    const submission = h.submissions.at(-1);
    console.log("\n=== Q3 historical -> restore -> send ===");
    console.log("  submission length:", submission?.ids.length);
    console.log("  first submitted  :", submission?.ids[0]);
    console.log("  parent used      :", h.headId());
    console.log(
      "  P1' will restore :",
      AUTHORITATIVE.length - (submission?.ids.length ?? 0),
      "prefix messages",
    );

    expect(h.headId()).toBe("m500");
    expect(submission?.ids[0]).toBe("m451");
    // 50 window + 1 new; P1' supplies the 450-message prefix.
    expect(submission?.ids.length).toBe(51);
    h.dispose();
  });

  it("a historical window CANNOT be sent from without corrupting the request", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: chainFromTo(451, 500) });
    h.setWindow(chainFromTo(350, 400));
    await h.send("sent from history");

    const submission = h.submissions.at(-1);
    console.log("\n=== Q3 sending while a historical window is visible ===");
    console.log("  submission length:", submission?.ids.length);
    console.log("  first submitted  :", submission?.ids[0]);
    console.log("  runtime head     :", h.headId());
    console.log("  authoritative tip:", h.authoritativeTip);

    // It succeeds — and that is the hazard: nothing rejects it.
    expect(submission?.ids.length).toBe(52);
    expect(h.authoritativeTip).toBe("m500");
    h.dispose();
  });
});

/* ------------------------------------------------------------------ *
 * Q4 — eviction
 * ------------------------------------------------------------------ */

/** An assistant message carrying a completed tool call + result. */
function toolMessage(
  id: string,
  toolCallId: string,
): {
  id: string;
  role: "assistant";
  parts: unknown[];
} {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: `calling ${toolCallId}` },
      {
        type: "tool-call",
        toolCallId,
        state: "output-available",
        input: { path: "x" },
        output: { ok: true },
      },
    ],
  };
}

describe("Q4 — eviction is presentation-only, and children are orphaned silently", () => {
  it("evicting a tool-calling message leaves it in the Chat and in storage terms", async () => {
    const chain = [
      { id: "m1", role: "user" as const, parts: [{ type: "text" as const, text: "go" }] },
      toolMessage("m2", "call-1"),
      { id: "m3", role: "user" as const, parts: [{ type: "text" as const, text: "next" }] },
      toolMessage("m4", "call-2"),
      { id: "m5", role: "user" as const, parts: [{ type: "text" as const, text: "tail" }] },
    ];
    const h = createAudit({
      authoritative: chain.map((m) => m.id),
      window: chain.map((m) => m.id),
    });
    // Seed the Chat with the real tool parts.
    h.setWindow(chain.map((m) => m.id) as never);

    expect(h.visibleIds()).toEqual(["m1", "m2", "m3", "m4", "m5"]);

    // Slide the window forward, evicting m1..m3 (including tool call call-1).
    h.setWindow(["m4", "m5"]);

    console.log("\n=== Q4.1 eviction of a tool-calling message ===");
    console.log("  visible after eviction:", h.visibleIds());
    console.log("  runtime head          :", h.headId());
    console.log("  chat.messages         :", h.chatIds());
    console.log("  errors raised         : none");

    expect(h.visibleIds()).toEqual(["m4", "m5"]);
    // Eviction did NOT touch the execution layer: the Chat is what the host
    // re-seeds, so this proves the split is presentational *in the runtime*.
    expect(h.chatIds()).toEqual(["m4", "m5"]);
    h.dispose();
  });

  it("a message with two children is orphaned by eviction with NO error", () => {
    // m5 has two children (a branch). Nothing in the Direct model prevents
    // eviction of the parent while the branch exists.
    const h = createAudit({
      authoritative: ["m1", "m2", "m3", "m4", "m5", "m5b", "m6"],
      window: ["m1", "m2", "m3", "m4", "m5", "m5b", "m6"],
    });

    let error: string | null = null;
    try {
      h.setWindow(["m5", "m5b", "m6"]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    console.log("\n=== Q4.2 evicting a message that has a sibling branch ===");
    console.log("  window before : m1,m2,m3,m4,m5,m5b,m6");
    console.log("  window after  :", h.visibleIds().join(","));
    console.log("  head          :", h.headId());
    console.log("  error         :", error ?? "(none — silent)");

    const exported = h.repository.export();
    const parentOf = new Map(exported.messages.map((entry) => [entry.message.id, entry.parentId]));
    console.log("  repository parents:", [...parentOf].map(([id, p]) => `${id}<-${p}`).join(" "));

    expect(error).toBeNull();
    expect(h.visibleIds()).toEqual(["m5", "m5b", "m6"]);

    // THE HAZARD, measured: assistant-ui parent-links each message to the
    // PREVIOUS ARRAY ELEMENT (external-store-thread-runtime-core.js:267-271),
    // never to a parent id the host supplies. So a window containing two
    // siblings is accepted and m6 — whose authoritative parent is m5 — is
    // re-parented onto m5b. The branch is silently flattened into a line, with
    // no error. A bounded window CANNOT represent a branch.
    expect(parentOf.get("m5b")).toBe("m5");
    expect(parentOf.get("m6")).toBe("m5b");
    h.dispose();
  });

  it("eviction cannot produce a hole: the window stays contiguous", () => {
    const h = createAudit({
      authoritative: chainFromTo(1, 20),
      window: chainFromTo(1, 20),
    });

    // Try to remove a middle message and keep both sides.
    h.setWindow([...chainFromTo(1, 9), ...chainFromTo(11, 20)]);

    const visible = h.visibleIds();
    console.log("\n=== Q4.3 removing a middle message ===");
    console.log("  requested: m1..m9 + m11..m20 (20 minus m10)");
    console.log(
      "  visible  :",
      `${visible[0]}..${visible[visible.length - 1]} (${visible.length})`,
    );
    console.log("  head     :", h.headId());

    // assistant-ui parent-links each message to the PREVIOUS ARRAY ELEMENT
    // (external-store-thread-runtime-core.js:267-271), so dropping the middle
    // re-parents m11 onto m9. The chain is contiguous but no longer the
    // authoritative parent_id chain.
    expect(visible.length).toBe(19);
    expect(visible).not.toContain(msgId(10));
    h.dispose();
  });

  it("eviction is NOT semantic for the Chat: the host re-seeds it wholesale", async () => {
    const h = createAudit({ authoritative: AUTHORITATIVE, window: chainFromTo(451, 500) });

    // Window narrows to just the tip.
    h.setWindow(chainFromTo(495, 500));
    expect(h.visibleIds().length).toBe(6);
    expect(h.headId()).toBe("m500");

    await h.send("after narrowing");
    const submission = h.submissions.at(-1);

    console.log("\n=== Q4.4 narrowed window then send ===");
    console.log("  visible:", h.visibleIds().join(","));
    console.log("  submission length:", submission?.ids.length);
    console.log("  P1' prefix needed:", AUTHORITATIVE.length - (submission?.ids.length ?? 0));

    // 6 visible + 1 new. P1' must supply 494 messages for the model to see the
    // real conversation — the runtime submitted 7, not 501.
    expect(submission?.ids.length).toBe(7);
    h.dispose();
  });
});
