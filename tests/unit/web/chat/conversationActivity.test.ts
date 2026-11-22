/**
 * Direct activity projection — publisher behavior.
 *
 * The Sidebar's running indicator is driven entirely by this projection, so
 * these tests pin the honest transitions: a live run is `running`, a terminal
 * state comes only from the server's durable verdict, and nothing ever
 * fabricates `idle` (a hidden or unmounted host may still be executing).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  directExecutionFromTerminalStatus,
  shouldPublishTerminal,
  useConversationActivityStore,
} from "@web/features/chat/state/conversationActivity";

const CONVERSATION = "conv-direct-1";

describe("Direct activity projection", () => {
  beforeEach(() => {
    useConversationActivityStore.getState().clear(CONVERSATION);
  });

  it("has no execution state until a publisher reports one", () => {
    expect(useConversationActivityStore.getState().get(CONVERSATION)).toBeUndefined();
    expect(useConversationActivityStore.getState().entries[CONVERSATION]).toBeUndefined();
  });

  it("reports running from a live run", () => {
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "running",
      engine: "direct",
    });
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("running");
  });

  it("maps only authoritative terminal kinds to terminal states", () => {
    expect(directExecutionFromTerminalStatus("completed")).toBe("completed");
    expect(directExecutionFromTerminalStatus("failed")).toBe("failed");
    expect(directExecutionFromTerminalStatus("cancelled")).toBe("cancelled");
    expect(directExecutionFromTerminalStatus("interrupted")).toBe("cancelled");
  });

  it("does not invent a terminal state from a missing verdict", () => {
    expect(directExecutionFromTerminalStatus(null)).toBeNull();
  });

  it("publishes completed, failed and cancelled from the server verdict", () => {
    for (const [kind, expected] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const) {
      useConversationActivityStore.getState().clear(CONVERSATION);
      const execution = directExecutionFromTerminalStatus(kind);
      if (execution === null) throw new Error("expected a terminal execution for a terminal kind");
      useConversationActivityStore.getState().publish(CONVERSATION, {
        execution,
        engine: "direct",
      });
      expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe(expected);
    }
  });

  it("never publishes idle when a host is hidden or torn down", () => {
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "running",
      engine: "direct",
    });
    // Teardown removes the entry; the fallback is unknown, never a fabricated idle.
    useConversationActivityStore.getState().clear(CONVERSATION);
    expect(useConversationActivityStore.getState().get(CONVERSATION)).toBeUndefined();
    expect(directExecutionFromTerminalStatus(null)).not.toBe("idle");
  });

  it("publishes a same-generation terminal verdict even while the projection shows running", () => {
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "running",
      engine: "direct",
    });
    // Normal completion: the verdict belongs to the run currently published.
    expect(shouldPublishTerminal(1, 1)).toBe(true);
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "completed",
      engine: "direct",
    });
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("completed");
  });

  it("blocks a stale terminal verdict when a newer run started", () => {
    expect(shouldPublishTerminal(1, 2)).toBe(false);
    expect(shouldPublishTerminal(0, 1)).toBe(false);
  });

  it("transitions running to completed on normal completion at the same generation", () => {
    // Run 1 starts: generation advances and the projection reports running.
    let generation = 0;
    generation += 1;
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "running",
      engine: "direct",
    });

    // Run 1 ends; the status read was started at the same generation and no
    // newer run intervened, so the authoritative verdict must be applied.
    const generationAtStart = generation;
    expect(shouldPublishTerminal(generationAtStart, generation)).toBe(true);
    const execution = directExecutionFromTerminalStatus("completed");
    if (execution === null) throw new Error("expected a terminal execution");
    useConversationActivityStore.getState().publish(CONVERSATION, { execution, engine: "direct" });
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("completed");
  });

  it("keeps running when a newer run starts during the status read", () => {
    let generation = 1;
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "running",
      engine: "direct",
    });

    // The verdict for run 1 was requested at generation 1. Run 2 starts while
    // the read is in flight, advancing the generation and republishing running.
    const generationAtStart = generation;
    generation += 1;
    useConversationActivityStore.getState().publish(CONVERSATION, {
      execution: "running",
      engine: "direct",
    });

    expect(shouldPublishTerminal(generationAtStart, generation)).toBe(false);
    expect(useConversationActivityStore.getState().get(CONVERSATION)?.execution).toBe("running");
  });
});
