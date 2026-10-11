/**
 * SPIKE — CONTRACT GAP: HISTORICAL_VIEW write-back vs. user mutation.
 * TEMPORARY, removable.
 *
 * The corrected contract proposes that HISTORICAL_VIEW disable user mutation.
 * The same runtime uses `setMessages` as a write-back channel, so the question
 * is whether those two responsibilities can be separated — and if so, with
 * which mechanism, and at what cost.
 *
 * Everything here is the real installed stack:
 *   @assistant-ui/core@0.3.24, @assistant-ui/ai-sdk@0.0.11,
 *   @ai-sdk/react@4.0.131, ai@7.0.93.
 */

import { describe, expect, it } from "bun:test";
import { chainFromTo, createAudit, type AuditHarness } from "../../helpers/dom/audit-harness.ts";

const AUTHORITATIVE = chainFromTo(1, 500);
const HISTORICAL = chainFromTo(351, 400);
const ACTIVE = chainFromTo(451, 500);

const historical = () =>
  createAudit({
    authoritative: AUTHORITATIVE,
    window: HISTORICAL,
    mutation: "historicalView",
  });

const active = () =>
  createAudit({ authoritative: AUTHORITATIVE, window: ACTIVE, mutation: "active" });

/** Attempt a user mutation and report how it failed, if it did. */
async function attempt(
  h: AuditHarness,
  kind: "append" | "edit" | "regenerate" | "delete" | "branch",
  parentId?: string,
): Promise<{ kind: string; blocked: boolean; error: string | null; submissions: number }> {
  const before = h.submissions.length;
  let error: string | null = null;
  try {
    if (kind === "append") await h.appendAt(parentId ?? h.headId(), "user text");
    else if (kind === "edit") await h.appendAt(parentId ?? "m390", "edited");
    else if (kind === "regenerate")
      await h.runtime.startRun({ parentId: parentId ?? "m390" } as never);
    else if (kind === "delete") await h.runtime.deleteMessage(parentId ?? "m390");
    else if (kind === "branch") h.runtime.switchToBranch(parentId ?? "m390");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await new Promise((r) => setTimeout(r, 20));
  return {
    kind,
    blocked: error !== null || h.submissions.length === before,
    error,
    submissions: h.submissions.length - before,
  };
}

describe("Gap 1 — HISTORICAL_VIEW: can write-back and user mutation be separated?", () => {
  it("BASELINE: in STABLE_ACTIVE every user mutation is permitted", async () => {
    const h = active();
    const caps = h.capabilities();

    console.log("\n=== baseline capabilities (active) ===");
    console.log("  ", JSON.stringify(caps));

    const results = [];
    for (const kind of ["append", "edit", "regenerate", "delete"] as const) {
      results.push(await attempt(h, kind, kind === "delete" ? "m460" : "m490"));
    }

    console.log("\n=== baseline user mutations (active) ===");
    for (const r of results) {
      console.log(
        `  ${r.kind.padEnd(11)} blocked=${String(r.blocked).padEnd(5)} submissions=${r.submissions} err=${r.error ?? "-"}`,
      );
    }

    expect(caps.edit).toBe(true);
    expect(caps.reload).toBe(true);
    expect(caps.delete).toBe(true);
    expect(caps.switchToBranch).toBe(true);
    h.dispose();
  });

  it("HISTORICAL_VIEW: omitting the callbacks blocks all five user mutations (A-E)", async () => {
    const h = historical();
    const caps = h.capabilities();

    console.log("\n=== HISTORICAL_VIEW capabilities ===");
    console.log("  ", JSON.stringify(caps));

    const results = [];
    for (const kind of ["append", "edit", "regenerate", "delete", "branch"] as const) {
      results.push(await attempt(h, kind));
    }

    console.log("\n=== HISTORICAL_VIEW user mutations ===");
    for (const r of results) {
      console.log(
        `  ${r.kind.padEnd(11)} blocked=${String(r.blocked).padEnd(5)} submissions=${r.submissions} err=${r.error ?? "-"}`,
      );
    }

    // A. append  — onNew is still wired (needed for the composer to exist at
    //    all), so append itself is NOT blocked by omitting onEdit. This is the
    //    honest result and it is why the composer must also be gated.
    expect(caps.edit).toBe(false);
    expect(caps.reload).toBe(false);
    expect(caps.delete).toBe(false);
    expect(caps.switchToBranch).toBe(false);

    // B/C/D/E all blocked.
    for (const kind of ["edit", "regenerate", "delete", "branch"] as const) {
      const r = results.find((x) => x.kind === kind)!;
      expect(r.submissions).toBe(0);
      expect(r.blocked).toBe(true);
    }

    h.dispose();
  });

  it("A. APPEND is NOT blocked by omitting callbacks — the composer must be gated", async () => {
    const h = historical();
    const r = await attempt(h, "append");

    console.log("\n=== A. append in HISTORICAL_VIEW ===");
    console.log("  submissions:", r.submissions, "error:", r.error ?? "(none)");
    console.log("  => onNew remains wired, so the runtime still accepts an append.");

    // This is the finding, not a pass: capability flags do NOT cover append.
    // Blocking it is a controller/composer responsibility, so the contract
    // cannot rely on store composition alone.
    expect(r.submissions).toBe(1);
    h.dispose();
  });

  it("F. streaming/state sync still reaches the store with setMessages absent", async () => {
    const h = historical();
    const hasSetMessages = (h.runtime as unknown as { _store: Record<string, unknown> })._store
      .setMessages;

    console.log("\n=== F. synchronization without setMessages ===");
    console.log("  store.setMessages present:", hasSetMessages !== undefined);
    expect(hasSetMessages).toBeUndefined();

    // The synchronization direction is host -> runtime via `messages` /
    // `isRunning`, which are retained. Re-publishing the window (which a
    // streaming host does on every chunk) must still update the runtime.
    h.republishWindow(chainFromTo(340, 400));
    const afterRepublish = h.visibleIds();

    console.log(
      "  visible after republish:",
      `${afterRepublish[0]}..${afterRepublish.at(-1)} (${afterRepublish.length})`,
    );

    expect(afterRepublish.length).toBe(61);
    expect(afterRepublish[0]).toBe("m340");
    // No write-back was needed to achieve it.
    expect(h.writeBacks.length).toBe(0);
    h.dispose();
  });

  it("G. tool state still reaches the store (tool parts survive sync)", async () => {
    const h = historical();
    const withTool: unknown[] = [
      { id: "m390", role: "user", parts: [{ type: "text", text: "run it" }] },
      {
        id: "m391",
        role: "assistant",
        parts: [
          { type: "text", text: "calling" },
          {
            type: "tool-call",
            toolCallId: "call-x",
            state: "input-available",
            input: { p: 1 },
          },
        ],
      },
      { id: "m392", role: "assistant", parts: [{ type: "text", text: "done" }] },
    ];
    h.seed(withTool);
    h.setMutationMode("historicalView");

    const exported = h.repository.export();
    const assistant = exported.messages.find((e) => e.message.id === "m391")
      ?.message as unknown as {
      content: Array<{ type: string; toolCallId?: string }>;
      status?: { type: string };
    };
    const toolParts = assistant?.content.filter((c) => c.type === "tool-call") ?? [];

    console.log("\n=== G. tool state via synchronization only ===");
    console.log("  visible:", h.visibleIds().join(","));
    console.log("  tool parts on m391:", toolParts.map((t) => t.toolCallId).join(","));
    console.log("  derived message status:", JSON.stringify(assistant?.status ?? null));

    expect(toolParts.length).toBe(1);
    expect(assistant?.status?.type).toBe("requires-action");
    h.dispose();
  });

  it("H. approval/question state still reaches the store", async () => {
    const h = historical();
    h.seed([
      { id: "m390", role: "user", parts: [{ type: "text", text: "delete it" }] },
      {
        id: "m391",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "call-del",
            state: "approval-requested",
            input: { path: "x" },
            approval: { id: "ap-1", prompt: "Delete x?" },
          },
        ],
      },
    ]);
    h.setMutationMode("historicalView");

    const exported = h.repository.export();
    const assistant = exported.messages.find((e) => e.message.id === "m391")
      ?.message as unknown as {
      content: Array<{ type: string; approval?: { id?: string } }>;
      status?: { type: string; reason?: string };
    };
    const approvalPart = assistant?.content.find((c) => c.type === "tool-call");

    console.log("\n=== H. approval state via synchronization only ===");
    console.log("  visible:", h.visibleIds().join(","));
    console.log("  approval id:", JSON.stringify(approvalPart?.approval ?? null));
    console.log("  message status:", JSON.stringify(assistant?.status ?? null));

    // The approval SURFACE is rendered from the store, and it arrived purely
    // through the synchronization direction.
    expect(approvalPart?.approval?.id).toBe("ap-1");
    h.dispose();
  });

  it("I. repository replacement still works with setMessages absent", async () => {
    const h = historical();
    expect(h.visibleIds().length).toBe(50);

    // Replace with a completely different contiguous run.
    h.republishWindow(chainFromTo(1, 20));
    const replaced = h.visibleIds();

    console.log("\n=== I. repository replacement ===");
    console.log("  visible:", `${replaced[0]}..${replaced.at(-1)} (${replaced.length})`);
    console.log("  head:", h.headId());

    expect(replaced.length).toBe(20);
    expect(replaced[0]).toBe("m1");
    expect(h.headId()).toBe("m20");
    h.dispose();
  });

  it("J. returning to STABLE_ACTIVE restores every mutation capability (and submit)", async () => {
    const h = historical();
    expect(h.capabilities().edit).toBe(false);

    // Restore the tip window AND re-publish the active store.
    h.setMutationMode("active");
    h.republishWindow(ACTIVE);

    const caps = h.capabilities();
    console.log("\n=== J. restored to STABLE_ACTIVE ===");
    console.log("  ", JSON.stringify(caps));

    expect(caps.edit).toBe(true);
    expect(caps.reload).toBe(true);
    expect(caps.delete).toBe(true);
    expect(caps.switchToBranch).toBe(true);

    // And a real submit works again.
    await h.send("back to normal");
    const submission = h.submissions.at(-1);
    console.log("  submission length:", submission?.ids.length);
    expect(submission?.ids.length).toBe(51);
    h.dispose();
  });

  it("the capability flags NEVER covered append — the composer must be gated", () => {
    const h = historical();
    const caps = h.capabilities();
    console.log("\n=== append capability ===");
    console.log("  capabilities:", JSON.stringify(caps));
    // There is no `append` capability at all in the runtime's flag set.
    expect(caps.append).toBeUndefined();
    h.dispose();
  });
});
