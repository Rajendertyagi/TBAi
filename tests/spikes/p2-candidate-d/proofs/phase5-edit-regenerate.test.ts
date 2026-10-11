/**
 * SPIKE — P2 Candidate D, Phase 5: edit / regenerate against a bounded window.
 * TEMPORARY, REMOVABLE.
 *
 * Executed against the REAL installed `sliceMessagesUntil` that
 * `useAISDKRuntime` uses for onEdit (line 558) and onReload (line 594). The
 * function is the whole mechanism: both call sites pass the Chat's own array,
 * so this measures exactly what production would do.
 *
 * Window: [m451..m500], authoritative [m1..m500].
 */

import { describe, expect, it } from "bun:test";
import { buildChain, sliceChain } from "../harness.ts";

const chain = buildChain(500);

// The real installed helper, imported by absolute path because it is not a
// public export. This is the SAME file the production runtime executes.
const AISDK_DIST =
  "D:/Temp/ai-chat-app/node_modules/.bun/@assistant-ui+ai-sdk@0.0.11+4c71a919fb8f23d6/node_modules/@ai-sdk/react/dist/index.js";
void AISDK_DIST;

const SLICE_MOD =
  "D:/Temp/ai-chat-app/node_modules/.bun/@assistant-ui+ai-sdk@0.0.11+4c71a919fb8f23d6/node_modules/@assistant-ui/ai-sdk/dist/utils/sliceMessagesUntil.js";

type Simple = { id: string; role: "user" | "assistant" };

const { sliceMessagesUntil } = (await import(SLICE_MOD)) as {
  sliceMessagesUntil: (messages: readonly Simple[], messageId: string | null) => Simple[];
};

const windowMessages = (): Simple[] => sliceChain(chain, 451, 500) as Simple[];

describe("P2 spike — edit target inside the window", () => {
  it("A. edit m490 (inside window): succeeds", () => {
    const messages = windowMessages();
    const sliced = sliceMessagesUntil(messages, "m490");
    console.log("=== PROBE A: edit m490 ===");
    console.log("window size:", messages.length, "sliced size:", sliced.length);
    expect(sliced.length).toBeGreaterThan(0);
    expect(sliced[sliced.length - 1].id).toBe("m490");
  });

  it("B. edit m451 (window root): succeeds", () => {
    const messages = windowMessages();
    const sliced = sliceMessagesUntil(messages, "m451");
    console.log("=== PROBE B: edit m451 ===");
    console.log("sliced size:", sliced.length);
    console.log("sliced ids:", sliced.map((m) => m.id).join(","));
    // m451 is a user message; the helper absorbs the FOLLOWING assistant
    // message, so editing a user message rewrites that whole turn.
    expect(sliced.length).toBe(2);
    expect(sliced[0].id).toBe("m451");
    expect(sliced[1].id).toBe("m452");
  });
});

describe("P2 spike — edit target OUTSIDE the window", () => {
  it("C. edit m400 (evicted): THROWS", () => {
    const messages = windowMessages();
    let outcome = "no throw";
    try {
      sliceMessagesUntil(messages, "m400");
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    console.log("=== PROBE C: edit m400 ===");
    console.log("outcome:", outcome);
    expect(outcome).toContain("not found");
  });

  it("D. branch point outside the window: THROWS identically", () => {
    const messages = windowMessages();
    let outcome = "no throw";
    try {
      sliceMessagesUntil(messages, "m2");
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    console.log("=== PROBE D: branch point m2 ===");
    console.log("outcome:", outcome);
    expect(outcome).toContain("not found");
  });
});

describe("P2 spike — the throw is unconditional, not a policy gap", () => {
  it("throws regardless of window size", () => {
    // Even a window that reaches m1 cannot edit m500's branch point if m500
    // itself is absent, and vice versa. Establish that the limit is structural.
    const wide = sliceChain(chain, 1, 500) as Simple[];
    expect(() => sliceMessagesUntil(wide, "m500")).not.toThrow();

    const narrow = sliceChain(chain, 451, 500) as Simple[];
    expect(() => sliceMessagesUntil(narrow, "m1")).toThrow();
  });

  it("regenerate has the same dependency on the target being present", () => {
    // onReload slices to parentId then calls chat.regenerate. Same helper.
    const messages = windowMessages();
    expect(() => sliceMessagesUntil(messages, "m400")).toThrow();
    expect(() => sliceMessagesUntil(messages, "m495")).not.toThrow();
  });

  it("a null parentId returns an empty slice, which is the 'regenerate the last turn' case", () => {
    expect(sliceMessagesUntil(windowMessages(), null)).toEqual([]);
  });
});