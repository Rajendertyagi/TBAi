/**
 * SPIKE — P2 Candidate D, Phase 6: explicit historical navigation.
 * TEMPORARY, REMOVABLE.
 *
 * Question: can the visible window move to [m350..m400] — mid-chain, tip at
 * m500 — purely as a VIEWING state, without changing the AI SDK Chat's
 * semantic head?
 *
 * Executed against the REAL ExternalStoreThreadRuntimeCore. The measurement
 * that matters is `repository.canonicalHeadId` before and after, because that
 * is what a subsequent append/edit resolves its parent against.
 */

import { describe, expect, it } from "bun:test";
import {
  buildChain,
  createSpike,
  sliceChain,
  toBranchableRepository,
} from "../harness.ts";

const chain = buildChain(500);

describe("P2 spike — historical navigation moves the semantic head", () => {
  it("navigating to m350..m400 changes canonicalHeadId from m500 to m400", () => {
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
    });
    try {
      expect(spike.repository.canonicalHeadId).toBe("m500");

      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)),
      });

      const head = spike.repository.canonicalHeadId;
      console.log("=== PROBE: explicit historical navigation ===");
      console.log("canonicalHeadId after navigating to m350..m400:", head);
      console.log("visible first:", spike.visibleIds()[0]);
      console.log("visible last:", spike.visibleIds()[spike.visibleIds().length - 1]);

      // MEASURED: the semantic head followed the window.
      expect(head).toBe("m400");
    } finally {
      spike.dispose();
    }
  });

  it("restoring the window restores the head", () => {
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
    });
    try {
      expect(spike.repository.canonicalHeadId).toBe("m500");
      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)),
      });
      expect(spike.repository.canonicalHeadId).toBe("m400");

      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
      });

      console.log("=== PROBE: restore window ===");
      console.log("canonicalHeadId after restoring m451..m500:", spike.repository.canonicalHeadId);
      expect(spike.repository.canonicalHeadId).toBe("m500");
    } finally {
      spike.dispose();
    }
  });

  it("m500 is physically gone after navigating away — restore had to re-supply it", () => {
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
    });
    try {
      expect(() => spike.repository.getMessage("m500")).not.toThrow();

      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)),
      });

      // With the messageRepository path, history is destroyed, not parked.
      expect(() => spike.repository.getMessage("m500")).toThrow();
      console.log("=== PROBE: m500 after navigating away ===");
      console.log("m500 retrievable:", false);
    } finally {
      spike.dispose();
    }
  });
});

describe("P2 spike — is there any display-only navigation channel?", () => {
  it("the messages path parks old messages off-head instead of deleting them", () => {
    const spike = createSpike({ messages: sliceChain(chain, 451, 500) });
    try {
      expect(spike.repository.canonicalHeadId).toBe("m500");

      spike.setStore({ messages: sliceChain(chain, 350, 400) });

      let retained = false;
      try {
        spike.repository.getMessage("m500");
        retained = true;
      } catch {
        retained = false;
      }

      console.log("=== PROBE: messages path, historical navigation ===");
      console.log("canonicalHeadId:", spike.repository.canonicalHeadId);
      console.log("m500 still retrievable:", retained);

      // Even here the head moves: the messages path is NOT a display-only view.
      expect(spike.repository.canonicalHeadId).toBe("m400");
      // The only difference is that the old tail survives in the repository,
      // so a host could switch back WITHOUT a refetch.
      expect(retained).toBe(true);
    } finally {
      spike.dispose();
    }
  });

  it("naming a head outside the window is rejected outright", () => {
    // The ONLY lever available for a display-only head is
    // messageRepository.headId. Supplying m500 while the window ends at m400
    // does not degrade gracefully — it throws from resetHead.
    const spike = createSpike({ messages: sliceChain(chain, 451, 500) });
    try {
      let outcome = "accepted";
      try {
        spike.setStore({
          messageRepository: {
            headId: "m500",
            messages: sliceChain(chain, 350, 400).map((message, index) => ({
              message,
              // index 0 is m350 (a window root, parent null); index i is
              // m(350+i) whose parent is m(350+i-1) = m(349+i).
              parentId: index === 0 ? null : `m${349 + index}`,
            })),
          },
        });
      } catch (error) {
        outcome = error instanceof Error ? error.message : String(error);
      }

      console.log("=== PROBE: explicit headId override ===");
      console.log("outcome:", outcome);

      // MEASURED HARD CONSTRAINT: the head must name a message present in the
      // supplied repository. There is no way to point the semantic head at a
      // conversation position the window does not contain.
      expect(outcome).toContain("Branch not found");
    } finally {
      spike.dispose();
    }
  });

  it("the head is always derivable from the window: last id, or an in-window headId", () => {
    const spike = createSpike({ messages: sliceChain(chain, 451, 500) });
    try {
      // Naming an IN-WINDOW id works and is honoured.
      spike.setStore({
        messageRepository: {
          headId: "m480",
          messages: sliceChain(chain, 451, 500).map((message, index) => ({
            message,
            parentId: index === 0 ? null : `m${450 + index}`,
          })),
        },
      });
      console.log("=== PROBE: in-window headId ===");
      console.log("canonicalHeadId:", spike.repository.canonicalHeadId);
      expect(spike.repository.canonicalHeadId).toBe("m480");
    } finally {
      spike.dispose();
    }
  });
});