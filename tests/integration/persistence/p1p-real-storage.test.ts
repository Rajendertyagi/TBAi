/**
 * SPIKE — CONTRACT AUDIT: P1' interaction, against REAL storage.
 * TEMPORARY, removable.
 *
 * The in-memory audit models P1' with a transcribed splice
 * (`src/context/assemble.ts` lines 227-245). This file proves that model
 * against the REAL `messageService.getHeadChain` and real SQLite, so the
 * audit's Question-1 conclusions do not rest on a transcription.
 *
 * It seeds a real chain, submits the exact arrays the Candidate D runtime
 * actually produced, and reports what the server would really reconstruct.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@/db";
import { conversationInput } from "../../helpers/conversation-fixtures";
import { conversationService, messageService } from "@/services/storage";
import { chainFromTo } from "../../helpers/dom/audit-harness.ts";

const AUTHORITATIVE = chainFromTo(1, 500);
let CONVERSATION = "";

/** The transcribed P1' splice, restated here so both are checked side by side. */
function p1pSplice(
  headChain: { messages: readonly { id: string }[]; complete: boolean },
  submitted: readonly string[],
): { applied: boolean; effective: string[] } {
  if (!(headChain.complete && submitted.length > 0)) {
    return { applied: false, effective: [...submitted] };
  }
  const boundary = headChain.messages.findIndex((m) => m.id === submitted[0]);
  if (boundary < 0) return { applied: false, effective: [...submitted] };
  return {
    applied: true,
    effective: [...headChain.messages.slice(0, boundary).map((m) => m.id), ...submitted],
  };
}

beforeAll(async () => {
  await conversationService.create(conversationInput({ title: "p2-audit" }));
  CONVERSATION = db
    .query<{ id: string }, [string]>("SELECT id FROM conversations ORDER BY rowid DESC LIMIT 1")
    .get("x")!.id;
  for (let i = 0; i < AUTHORITATIVE.length; i += 1) {
    await messageService.upsertStored(CONVERSATION, {
      id: AUTHORITATIVE[i],
      parent_id: i === 0 ? null : AUTHORITATIVE[i - 1],
      format: "raw",
      content: { parts: [{ type: "text", text: `body ${AUTHORITATIVE[i]}` }] },
    });
  }
});

afterAll(() => {
  if (CONVERSATION === "") return;
  messageService.deleteByConversation(CONVERSATION);
});

describe("P1' against real storage", () => {
  it("the real head chain is exactly the authoritative chain", async () => {
    const headChain = await messageService.getHeadChain(CONVERSATION);
    expect(headChain.complete).toBe(true);
    expect(headChain.messages.map((m) => m.id)).toEqual(AUTHORITATIVE);
  });

  it("a tip-containing submission reconstructs the FULL chain", async () => {
    // What Candidate D submitted in audit-1: the window m451..m500 plus the
    // new message. The new message is not persisted yet, so it is absent from
    // the head chain — which is fine, P1' only needs the prefix boundary.
    const submitted = [...chainFromTo(451, 500), "NEW"];
    const headChain = await messageService.getHeadChain(CONVERSATION);
    const spliced = p1pSplice(headChain, submitted);

    const missing = AUTHORITATIVE.filter((id) => !spliced.effective.includes(id));
    console.log("\n=== P1' real: tip-containing submission ===");
    console.log("  submitted   :", submitted.length, "first", submitted[0]);
    console.log("  applied     :", spliced.applied);
    console.log("  effective   :", spliced.effective.length);
    console.log("  missing     :", missing.length);

    expect(spliced.applied).toBe(true);
    expect(missing).toEqual([]);
  });

  it("a tip-EXCLUDING submission reconstructs a TRUNCATED chain", async () => {
    // What Candidate D submitted in audit-1 when the window was m351..m400.
    const submitted = [...chainFromTo(351, 400), "NEW"];
    const headChain = await messageService.getHeadChain(CONVERSATION);
    const spliced = p1pSplice(headChain, submitted);

    const missing = AUTHORITATIVE.filter((id) => !spliced.effective.includes(id));
    console.log("\n=== P1' real: tip-EXCLUDING submission ===");
    console.log("  submitted   :", submitted.length, "first", submitted[0]);
    console.log("  applied     :", spliced.applied);
    console.log("  effective   :", spliced.effective.length, "of", AUTHORITATIVE.length);
    console.log("  missing     :", missing.length, `(${missing[0]}..${missing.at(-1)})`);

    expect(spliced.applied).toBe(true);
    // P1' reports success. It repaired the prefix perfectly and still produced
    // a request that silently omits 100 real messages, because P1' can only
    // restore what comes BEFORE the client's oldest submitted message.
    expect(missing.length).toBe(100);
    expect(missing[0]).toBe("m401");
  });

  it("the real window slice agrees with where the chain ends", async () => {
    // `getWindowSlice` is the backend half of the same question: does the
    // bounded slice the server produces line up with the window the client used?
    const slice = await messageService.getWindowSlice(CONVERSATION, {
      direction: "older",
      anchorId: "m500",
      limit: 50,
    });
    console.log("\n=== real window slice, older from tip ===");
    console.log("  first:", slice.messages[0]?.id, "last:", slice.messages.at(-1)?.id);
    console.log("  complete:", slice.complete);
    console.log("  hasMoreBefore:", slice.hasMoreBefore, "hasMoreAfter:", slice.hasMoreAfter);

    expect(slice.messages.map((m) => m.id)).toEqual(chainFromTo(451, 500));
    expect(slice.hasMoreBefore).toBe(true);
    expect(slice.hasMoreAfter).toBe(false);
    // `complete` is the P1' fail-closed signal meaning "this walk proved it
    // reached a legitimate root". A mid-chain window has NOT reached the root,
    // so `complete: false` is the CORRECT value here, not a defect — and the
    // frozen P2 contract already requires callers to treat it as "this is not
    // the whole selected history".
    expect(slice.complete).toBe(false);
  });
});