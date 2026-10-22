/**
 * The admission registry is bounded.
 *
 * ## THE GAP THIS CLOSES
 *
 * The plan's Phase 6 item (P9) names `admissions` among the collections the
 * retention policy must bound: *"bound `admissions`, `answeredPermissions`,
 * `autoApproveAttempted` and `formReplies` with a TTL sweep plus a max-entry
 * cap"*.
 *
 * Phase 6 converted the other three and left `admissions` an unbounded
 * `Map`. Every prompt added an entry, `settle()` recorded the outcome but
 * never removed it, and `disposeAll()` only settled. So a long session grew
 * the registry without limit - the very defect L1 was raised to close.
 *
 * ## THE TWO CLASSES
 *
 * - a **settled** record (the prompt was answered and nobody is waiting) is
 *   evictable: the only question it answers is "what happened to this
 *   prompt?", and the server can answer that too.
 * - a record with a **waiter** on it is protected: evicting it would drop a
 *   waiter that would then never be woken.
 */

import { describe, expect, it } from "bun:test";
import { OPENCODE_V2_RETENTION_CAP } from "@web/features/opencode/config.ts";
import { createPromptsInFlight } from "@web/features/opencode/sync/promptsInFlight.ts";

describe("the admission registry stays bounded", () => {
  it("does not grow without limit as prompts are sent and answered", async () => {
    const registry = createPromptsInFlight();

    // Far more prompts than the cap allows. Each is created and then settled,
    // which is what a finished turn looks like.
    const total = OPENCODE_V2_RETENTION_CAP + 200;
    for (let index = 0; index < total; index += 1) {
      const messageId = `msg_${index}`;
      registry.create(messageId);
      registry.settle(messageId, "admitted");
    }

    // The registry is bounded. The observable form: the records that were
    // settled long ago are GONE, so asking for one of them finds nothing.
    expect(registry.get("msg_0")).toBeUndefined();
    // And the newest is still there - the sweep evicts the OLDEST.
    expect(registry.get(`msg_${total - 1}`)).toBeDefined();
  });

  it("keeps a record that still has a waiter on it", async () => {
    const registry = createPromptsInFlight();

    // One prompt with a waiter that never settles.
    const waited = registry.awaitAdmission("msg_waited");
    let woke: string | null = null;
    void waited.then((result) => {
      woke = result;
    });

    // Many other prompts, settled, so the collection is over its cap.
    const total = OPENCODE_V2_RETENTION_CAP + 200;
    for (let index = 0; index < total; index += 1) {
      const messageId = `msg_${index}`;
      registry.create(messageId);
      registry.settle(messageId, "admitted");
    }

    // The waited record SURVIVED the sweep: it still has a waiter on it, and
    // evicting it would drop that waiter - which would then never be woken.
    expect(registry.get("msg_waited")).toBeDefined();

    // And when it is finally settled, the waiter IS woken - which is the
    // whole reason it was protected.
    registry.settle("msg_waited", "admitted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(woke).toBe("admitted");
  });
});
