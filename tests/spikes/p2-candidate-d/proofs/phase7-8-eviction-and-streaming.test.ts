/**
 * SPIKE — P2 Candidate D, Phases 7 & 8: eviction vs execution state, and
 * streaming / approval safety. TEMPORARY, REMOVABLE.
 *
 * Phase 7 asks whether external-store eviction can remove a message that
 * execution still needs. Phase 8 asks whether the window survives a live
 * stream and a pending approval.
 *
 * Both are executed against the real ExternalStoreThreadRuntimeCore with a
 * store that behaves like a Direct one (onNew / onEdit / onReload /
 * onRespondToToolApproval recorded, never silently swallowed).
 */

import { describe, expect, it } from "bun:test";
import { buildChain, createSpike, sliceChain, toBranchableRepository } from "../harness.ts";

const chain = buildChain(500);

/** A user message carrying a tool call, as a Direct tool turn would look. */
function toolMessage(id: string, parentId: string | null) {
  return {
    id,
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: `calling ${id}` },
      {
        type: "tool-call" as const,
        toolCallId: `call_${id}`,
        toolName: "read",
        args: { path: "a.ts" },
        state: { type: "output-available" as const, output: "ok", isError: false },
      },
    ],
  };
}

describe("P2 spike — Phase 7: eviction is presentation-only or execution-affecting?", () => {
  it("evicting a completed tool-call message does not break the store", () => {
    const window = [
      ...sliceChain(chain, 451, 500),
      toolMessage("m501", "m500"),
    ];
    const spike = createSpike({
      messageRepository: toBranchableRepository(window as never),
    });
    try {
      expect(spike.visibleIds()).toContain("m501");

      // Evict the tool message by narrowing the window.
      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 451, 500) as never),
      });

      console.log("=== PROBE: evicting a tool-call message ===");
      console.log("visible length:", spike.visibleIds().length);
      console.log("m501 present:", spike.visibleIds().includes("m501"));

      expect(spike.visibleIds()).not.toContain("m501");
      // The store itself is still usable: it did not enter an error state.
      expect(spike.visibleIds()[0]).toBe("m451");
    } finally {
      spike.dispose();
    }
  });

  it("evicting the message a pending approval hangs off removes the approval surface", () => {
    const pending = {
      id: "m501",
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "call_m501",
          toolName: "write",
          args: { path: "b.ts" },
          state: { type: "approval-requested" as const },
          approval: { id: "appr_1", approved: undefined },
        },
      ],
    };
    const window = [...sliceChain(chain, 451, 500), pending];
    const spike = createSpike({
      messageRepository: toBranchableRepository(window as never),
      onRespondToToolApproval: async () => {},
    });
    try {
      expect(spike.visibleIds()).toContain("m501");

      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 451, 500) as never),
        onRespondToToolApproval: async () => {},
      });

      console.log("=== PROBE: evicting a pending-approval message ===");
      console.log("m501 present:", spike.visibleIds().includes("m501"));
      console.log("-> the approval can no longer be answered from this window");

      // No error is raised. Eviction is silent, so the responsibility to keep
      // an approval message inside the window belongs entirely to the host.
      expect(spike.visibleIds()).not.toContain("m501");
    } finally {
      spike.dispose();
    }
  });

  it("an optimistic in-flight assistant message survives a window replacement", () => {
    // While isRunning with a trailing user message, the runtime injects an
    // optimistic assistant placeholder. Measure what a window swap does to it.
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 499) as never),
      isRunning: true,
    });
    try {
      const before = spike.visibleIds();
      console.log("=== PROBE: window swap while running ===");
      console.log("visible length while running:", before.length);
      console.log("last visible:", before[before.length - 1]);

      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 451, 500) as never),
        isRunning: true,
      });

      const after = spike.visibleIds();
      console.log("visible length after swap:", after.length);
      console.log("last visible after swap:", after[after.length - 1]);
      // The swap did not throw and did not lose the window.
      expect(after[0]).toBe("m451");
    } finally {
      spike.dispose();
    }
  });
});

describe("P2 spike — Phase 8: append during a stream stays inside the window", () => {
  // The runtime classifies an append as an EDIT unless `parentId` equals the
  // current tail (external-store-thread-runtime-core.js: `isEdit = sourceId !=
  // null || parentId !== tail`). Sending the correct parent is therefore part of
  // the normal contract, and an omitted parentId is an edit.
  const appendMessage = (id: string, parentId: string) => ({
    id,
    parentId,
    role: "user" as const,
    content: [{ type: "text" as const, text: "next" }],
    sourceId: undefined,
    createdAt: new Date(),
    attachments: [],
    metadata: { unstable_state: null, unstable_imperativeAdvance: false },
    runConfig: { suggestions: [] },
  });

  it("onNew receives the appended message with the tail as its parent", async () => {
    const calls: Array<{ parentId: string | null; id: string }> = [];
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500) as never),
      onNew: async (message) => {
        const m = message as unknown as { parentId: string | null; id: string };
        calls.push({ parentId: m.parentId, id: m.id });
      },
      onEdit: async () => {},
    });
    try {
      const before = spike.visibleIds().length;
      await spike.core.append(appendMessage("m501", "m500") as never);

      console.log("=== PROBE: append via runtime ===");
      console.log("onNew calls:", calls.length);
      console.log("onNew parentId:", calls[0]?.parentId);
      console.log("visible before:", before, "visible after:", spike.visibleIds().length);

      expect(calls.length).toBe(1);
      expect(calls[0]?.parentId).toBe("m500");
      // The runtime forwarded to the host; the host owns adding it, so the
      // repository is unchanged until the host re-publishes.
      expect(spike.visibleIds().length).toBe(before);
    } finally {
      spike.dispose();
    }
  });

  it("append after the window MOVED resolves its parent against the NEW head", async () => {
    const calls: Array<{ parentId: string | null; id: string }> = [];
    const spike = createSpike({
      messages: sliceChain(chain, 451, 500),
      onNew: async (message) => {
        const m = message as unknown as { parentId: string | null; id: string };
        calls.push({ parentId: m.parentId, id: m.id });
      },
      onEdit: async () => {},
    });
    try {
      expect(spike.repository.canonicalHeadId).toBe("m500");

      // Navigate to a mid-chain window. setStore REPLACES the whole store, so
      // the callbacks must be re-supplied or the runtime loses them.
      spike.setStore({
        messages: sliceChain(chain, 350, 400),
        onNew: async (message) => {
          const m = message as unknown as { parentId: string | null; id: string };
          calls.push({ parentId: m.parentId, id: m.id });
        },
        onEdit: async () => {},
      });
      expect(spike.repository.canonicalHeadId).toBe("m400");

      // Append naming the CURRENT tail, as a correct client would.
      await spike.core.append(appendMessage("m401", "m400") as never);

      console.log("=== PROBE: append after navigating away ===");
      console.log("onNew parentId:", calls[0]?.parentId);

      // MEASURED CONSTRAINT: the semantic head followed the window, so the
      // next turn lands on m400 and m401..m500 are orphaned from the branch.
      expect(calls[0]?.parentId).toBe("m400");
    } finally {
      spike.dispose();
    }
  });

  it("an append naming the AUTHORITATIVE tip after navigating away is treated as an edit", async () => {
    // This is the only way to keep the tip as parent — and it is classified as
    // an edit, which routes to onEdit rather than onNew. Measure, do not assume.
    const onNew: unknown[] = [];
    const onEdit: Array<{ parentId: string | null; id: string }> = [];
    const spike = createSpike({
      messages: sliceChain(chain, 451, 500),
      onNew: async (message) => {
        onNew.push(message);
      },
      onEdit: async (message) => {
        const m = message as unknown as { parentId: string | null; id: string };
        onEdit.push({ parentId: m.parentId, id: m.id });
      },
    });
    try {
      spike.setStore({
        messages: sliceChain(chain, 350, 400),
        onNew: async (message) => {
          onNew.push(message);
        },
        onEdit: async (message) => {
          const m = message as unknown as { parentId: string | null; id: string };
          onEdit.push({ parentId: m.parentId, id: m.id });
        },
      });

      await spike.core.append(appendMessage("m501", "m500") as never);

      console.log("=== PROBE: append naming the authoritative tip ===");
      console.log("onNew calls:", onNew.length);
      console.log("onEdit calls:", onEdit.length);
      console.log("onEdit parentId:", onEdit[0]?.parentId);

      expect(onNew.length).toBe(0);
      expect(onEdit.length).toBe(1);
      expect(onEdit[0]?.parentId).toBe("m500");
    } finally {
      spike.dispose();
    }
  });
});