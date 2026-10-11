/**
 * SPIKE — P2 Candidate D, Phase 3: bounded repository behavior.
 * TEMPORARY, REMOVABLE.
 *
 * Executes the REAL ExternalStoreThreadRuntimeCore against a 500-message chain
 * to answer, by measurement:
 *   1. only the bounded window renders
 *   2. a new repository instance evicts messages outside it
 *   3. older messages can be prepended
 *   4. ids stay stable across both operations
 *   6. eviction actually removes them
 */

import { describe, expect, it } from "bun:test";
import {
  buildChain,
  createSpike,
  sliceChain,
  toBranchableRepository,
  type UiMessage,
} from "../harness.ts";

const chain = buildChain(500);

describe("P2 spike — bounded window renders only the window", () => {
  it("renders exactly the bounded window [451..500]", () => {
    const window = sliceChain(chain, 451, 500);
    const spike = createSpike({ messageRepository: toBranchableRepository(window) });
    try {
      expect(spike.visibleIds().length).toBe(50);
      expect(spike.visibleIds()[0]).toBe("m451");
      expect(spike.visibleIds()[49]).toBe("m500");
      // The 450 evicted-from messages are genuinely absent, not merely hidden.
      expect(spike.visibleIds()).not.toContain("m1");
      expect(spike.visibleIds()).not.toContain("m450");
      // getMessage THROWS on absence, so absence is observed as a throw.
      expect(() => spike.repository.getMessage("m1")).toThrow();
    } finally {
      spike.dispose();
    }
  });

  it("renders nothing extra when a full 500-message repository is supplied", () => {
    const spike = createSpike({ messageRepository: toBranchableRepository(chain) });
    try {
      expect(spike.visibleIds().length).toBe(500);
      expect(spike.visibleIds()[0]).toBe("m1");
    } finally {
      spike.dispose();
    }
  });
});

describe("P2 spike — replacing the repository evicts", () => {
  it("evicts everything outside a smaller bounded window", () => {
    const spike = createSpike({ messageRepository: toBranchableRepository(chain) });
    try {
      expect(spike.visibleIds().length).toBe(500);

      // Host narrows the window to [451..500].
      spike.setStore({ messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)) });

      expect(spike.visibleIds().length).toBe(50);
      expect(spike.visibleIds()[0]).toBe("m451");
      expect(spike.visibleIds()).not.toContain("m1");
      expect(() => spike.repository.getMessage("m1")).toThrow();
    } finally {
      spike.dispose();
    }
  });

  it("evicts the tail when the window is repositioned forward (m350..m400)", () => {
    const spike = createSpike({ messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)) });
    try {
      expect(spike.visibleIds()[0]).toBe("m451");

      spike.setStore({ messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)) });

      expect(spike.visibleIds().length).toBe(51);
      expect(spike.visibleIds()[0]).toBe("m350");
      expect(spike.visibleIds()[50]).toBe("m400");
      // The previously-visible tail is gone: this is what makes the tip
      // disappear, which Phase 4/6 have to measure.
      expect(spike.visibleIds()).not.toContain("m500");
      expect(spike.visibleIds()).not.toContain("m451");
    } finally {
      spike.dispose();
    }
  });
});

describe("P2 spike — prepending older messages", () => {
  it("prepends [401..450] to a [451..500] window and keeps ids stable", () => {
    const originalWindow = sliceChain(chain, 451, 500);
    const spike = createSpike({ messageRepository: toBranchableRepository(originalWindow) });
    try {
      const before = spike.visibleIds();
      expect(before[0]).toBe("m451");

      const merged = [...sliceChain(chain, 401, 450), ...originalWindow];
      spike.setStore({ messageRepository: toBranchableRepository(merged) });

      const after = spike.visibleIds();
      expect(after.length).toBe(100);
      expect(after[0]).toBe("m401");
      expect(after[99]).toBe("m500");
      // Every id that was already visible is still visible, in the same order,
      // at the same relative position — this is the "stable ids" claim.
      expect(after.slice(50)).toEqual(before);
      for (const id of before) expect(after).toContain(id);
    } finally {
      spike.dispose();
    }
  });

  it("keeps the window contiguous across repeated prepends", () => {
    let window: UiMessage[] = sliceChain(chain, 451, 500);
    const spike = createSpike({ messageRepository: toBranchableRepository(window) });
    try {
      // Prepend 50 at a time: 401..450, then 351..400, then 301..350.
      for (const start of [401, 351, 301]) {
        window = [...sliceChain(chain, start, start + 49), ...window];
        spike.setStore({ messageRepository: toBranchableRepository(window) });
      }
      const ids = spike.visibleIds();
      expect(ids.length).toBe(200);
      expect(ids[0]).toBe("m301");
      expect(ids[199]).toBe("m500");
      // Contiguous by parent link: assert the visible order has no gaps rather
      // than trusting that it does.
      for (let i = 1; i < ids.length; i += 1) {
        expect(ids[i]).toBe(`m${301 + i}`);
      }
    } finally {
      spike.dispose();
    }
  });
});

describe("P2 spike — messages path vs messageRepository path", () => {
  it("messages path does NOT delete; it moves the head and keeps the rest off-head", () => {
    // MEASURED, not assumed: narrowing `messages` to [350..400] makes the
    // visible list 51 long, yet m500 is still retrievable from the repository.
    // That is a head move, not an eviction.
    const spike = createSpike({ messages: sliceChain(chain, 451, 500) });
    try {
      expect(spike.visibleIds().length).toBe(50);

      spike.setStore({ messages: sliceChain(chain, 350, 400) });

      expect(spike.visibleIds().length).toBe(51);
      expect(spike.visibleIds()[0]).toBe("m350");
      expect(spike.visibleIds()).not.toContain("m500");

      // The old tail still exists in the repository, just off the head chain.
      expect(() => spike.repository.getMessage("m500")).not.toThrow();
      // And the semantic head really did move.
      expect(spike.repository.canonicalHeadId).toBe("m400");
    } finally {
      spike.dispose();
    }
  });

  it("messageRepository path DOES delete messages outside the window", () => {
    const spike = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
    });
    try {
      expect(() => spike.repository.getMessage("m500")).not.toThrow();
      spike.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)),
      });
      // Genuinely gone — this is the only path that frees memory.
      expect(() => spike.repository.getMessage("m500")).toThrow();
    } finally {
      spike.dispose();
    }
  });

  it("the two paths therefore trade off memory against recoverability", () => {
    const viaRepository = createSpike({
      messageRepository: toBranchableRepository(sliceChain(chain, 451, 500)),
    });
    const viaMessages = createSpike({ messages: sliceChain(chain, 451, 500) });
    try {
      viaRepository.setStore({
        messageRepository: toBranchableRepository(sliceChain(chain, 350, 400)),
      });
      viaMessages.setStore({ messages: sliceChain(chain, 350, 400) });

      // Both render only the window...
      expect(viaRepository.visibleIds()).not.toContain("m500");
      expect(viaMessages.visibleIds()).not.toContain("m500");
      // ...but only the repository path is a real bounded memory footprint.
      expect(() => viaRepository.repository.getMessage("m500")).toThrow();
      expect(() => viaMessages.repository.getMessage("m500")).not.toThrow();
    } finally {
      viaRepository.dispose();
      viaMessages.dispose();
    }
  });
});