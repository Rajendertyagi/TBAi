/**
 * SPIKE — probe: does narrowing via `messages` DELETE, or only move the head?
 * TEMPORARY, REMOVABLE.
 *
 * The first run showed `messages` narrowing appearing to evict. That is the
 * observable result of `resetHead(newTail)` plus re-parenting the array's first
 * element to null — not a delete. Whether the old messages survive inside the
 * repository decides whether Phase 5/6 semantics can still reach them.
 */

import { describe, expect, it } from "bun:test";
import { buildChain, createSpike, sliceChain, toBranchableRepository } from "../harness.ts";

const chain = buildChain(500);

describe("P2 spike — messages-path narrowing: delete vs head move", () => {
  it("reports whether the old tail survives inside the repository", () => {
    const spike = createSpike({ messages: sliceChain(chain, 451, 500) });
    try {
      expect(spike.visibleIds()[0]).toBe("m451");
      const survivesBefore = spike.repository.getMessage("m500");
      expect(survivesBefore).toBeDefined();

      spike.setStore({ messages: sliceChain(chain, 350, 400) });

      const ids = spike.visibleIds();
      let outcome: string;
      try {
        spike.repository.getMessage("m500");
        outcome = "PRESENT (retained off-head)";
      } catch {
        outcome = "ABSENT (deleted)";
      }

      // Record the measured truth rather than asserting a guess either way.
      console.log("=== PROBE: messages path narrowing ===");
      console.log("visible count:", ids.length);
      console.log("visible first:", ids[0]);
      console.log("visible last:", ids[ids.length - 1]);
      console.log("repository.getMessage(m500):", outcome);

      const branches = spike.repository.getBranches("m400");
      console.log("branches off m400:", JSON.stringify(branches));
      console.log("canonicalHeadId:", spike.repository.canonicalHeadId);

      expect(outcome).toBe("PRESENT (retained off-head)");
    } finally {
      spike.dispose();
    }
  });

  it("compares against the messageRepository path, which does delete", () => {
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
    });
    try {
      expect(spike.repository.getMessage("m500")).toBeDefined();
      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)),
      });
      // getMessage THROWS when absent (it is not an optional lookup), so absence
      // is observed as a throw rather than an undefined return.
      let outcome: string;
      try {
        spike.repository.getMessage("m500");
        outcome = "PRESENT (retained)";
      } catch {
        outcome = "ABSENT (deleted)";
      }
      console.log("=== PROBE: messageRepository path narrowing ===");
      console.log("repository.getMessage(m500):", outcome);
      expect(outcome).toBe("ABSENT (deleted)");
    } finally {
      spike.dispose();
    }
  });
});