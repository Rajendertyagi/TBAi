/**
 * The admission registry is bounded.
 *
 * Settled records with no protections/waiters are evictable. Records with active
 * protections (admission/outcome waiters, cancellation intents, controller
 * bindings) must never be evicted.
 */

import { describe, expect, it } from "bun:test";
import { OPENCODE_V2_RETENTION_CAP } from "@web/features/opencode/config.ts";
import { createPromptsInFlight } from "@web/features/opencode/sync/promptsInFlight.ts";

const SESSION_ID = "ses_retention";

describe("the admission registry stays bounded", () => {
  it("does not grow without limit as prompts are sent and answered", () => {
    const registry = createPromptsInFlight();

    // Many more prompts than the cap, each settled and with no protections -
    // which is what a finished turn looks like.
    const total = OPENCODE_V2_RETENTION_CAP + 200;
    for (let index = 0; index < total; index += 1) {
      const messageId = `msg_${index}`;
      registry.create(SESSION_ID, messageId);
      registry.settleVerdict(messageId, "admitted");
    }

    // The registry must not have kept every record. It may keep up to the cap,
    // but it must not grow with the number of prompts sent.
    expect(registry.size).toBeLessThanOrEqual(OPENCODE_V2_RETENTION_CAP);
  });

  it("never evicts a record that still has a waiter on it", async () => {
    const registry = createPromptsInFlight();

    // A prompt that is still in flight: someone is waiting for its admission,
    // so the record is PROTECTED. Evicting it would drop the waiter, and the
    // waiter would then never be woken.
    const protectedId = "msg_protected";
    registry.create(SESSION_ID, protectedId);
    const admission = registry.awaitAdmission(protectedId);

    // Many other prompts, settled, so the collection is over its cap.
    const total = OPENCODE_V2_RETENTION_CAP + 200;
    for (let index = 0; index < total; index += 1) {
      const messageId = `msg_${index}`;
      registry.create(SESSION_ID, messageId);
      registry.settleVerdict(messageId, "admitted");
    }

    // The protected record is still there, and settling it still wakes the
    // waiter - which is the proof that it was never evicted.
    expect(registry.get(protectedId)).toBeDefined();
    registry.settleVerdict(protectedId, "admitted");
    await expect(admission).resolves.toBe("admitted");
  });
});
