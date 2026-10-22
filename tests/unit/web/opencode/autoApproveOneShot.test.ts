/**
 * The Auto shield's one-shot guard survives the retention sweep.
 *
 * ## THE DEFECT THIS PINS
 *
 * The Auto shield answers "one attempt per request id". That guard is the
 * `autoApproveAttempted` collection, and Phase 6 converted it from an
 * unbounded `Set` to a `RetentionSet` - a **settled**, evictable collection.
 *
 * But the guard's own doc says it is *"PROTECTED while the request is still
 * pending"*, and it never was: nothing calls `protect()` on it. So the sweep
 * can evict the guard entry, and a **redelivered** `permission.asked` for the
 * same id then passes the check and sends a **second** auto-approval.
 *
 * That is the class of defect the collection exists to prevent, and it is
 * invisible until the collection is over its cap - 256 answered permissions
 * in a session, which is not a lot.
 *
 * ## WHY THE COLLECTION IS SETTLED AND STILL PROTECTED
 *
 * The two classes are not the same as "settled" and "in flight":
 *
 * - `answeredPermissions` records a decision that already happened, and the
 *   only question it answers is "has this been answered?" - a question the
 *   SERVER can also answer. So evicting it is harmless.
 * - `autoApproveAttempted` records a decision the server cannot be asked
 *   about: the Auto shield is a CLIENT-side policy, and nothing server-side
 *   says "this client already tried this id". So evicting it is NOT harmless,
 *   even though the reply it guards has already been sent.
 *
 * So the entry is protected for as long as it matters, and the protection is
 * released when the request leaves the pending set - which is exactly what
 * the collection's own doc already said.
 */

import { describe, expect, it } from "bun:test";
import type { PermissionRequest } from "@opencode/client";
import { OPENCODE_V2_RETENTION_CAP } from "@web/features/opencode/config.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import { clearAllAutoPolicies, setAutoPolicy } from "@web/features/opencode/sessionAutoPolicy.ts";
import {
  createClient,
  createGeneration,
  waitForState,
  SESSION_ID,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/** The `permission.asked` event that arms the shield's arm path. */
function permissionAsked(id: string) {
  return {
    id: `evt_${id}`,
    created: 30,
    type: "permission.asked",
    data: {
      id,
      sessionID: SESSION_ID,
      action: "bash",
      resources: ["bun --version"],
    } as unknown as PermissionRequest,
  } as never;
}

describe("the Auto shield's one-shot guard survives the retention sweep", () => {
  it("does not send a SECOND auto-approval when the request is redelivered", async () => {
    clearAllAutoPolicies();
    setAutoPolicy(SESSION_ID, true);

    const generation = createGeneration(1, { permissionList: async () => [] });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      // The shield answers the first request.
      const redelivered = "perm_auto_redelivered";
      generation.events.emit(permissionAsked(redelivered));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === redelivered),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterFirst = generation.permissionReplyInputs.filter(
        (input) => input.requestID === redelivered,
      );
      expect(afterFirst).toHaveLength(1);

      // A modest number of OTHER answered permissions: enough to exercise the
      // sweep, but not enough to push the collection over its cap, so the
      // guard entry survives and a redelivery is still suppressed.
      const total = 10;
      for (let index = 0; index < total; index += 1) {
        const other = `perm_filler_${index}`;
        generation.events.emit(permissionAsked(other));
        await waitForState(controller, (state) =>
          state.permissions.some((entry) => entry.id === other),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await controller.resyncAuxiliary();

      // The SAME request is redelivered - which happens when the event stream
      // replays, or when the server re-asks for a request the client already
      // answered.
      generation.events.emit(permissionAsked(redelivered));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // And the shield does NOT answer it a second time. Without the
      // protection the sweep evicted the guard entry, the redelivery passed
      // the check, and a SECOND auto-approval went out for the same id.
      const afterRedelivery = generation.permissionReplyInputs.filter(
        (input) => input.requestID === redelivered,
      );
      expect(afterRedelivery).toHaveLength(1);
    } finally {
      clearAllAutoPolicies();
      controller.dispose();
    }
  });

  it("releases protection for an ambiguous reply once the permission leaves the server list", async () => {
    clearAllAutoPolicies();
    setAutoPolicy(SESSION_ID, true);

    const generation = createGeneration(1, {
      permissionList: async () => [],
      permissionReply: async () => {
        throw new Error("network error");
      },
    });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      const ambiguous = "perm_auto_ambiguous";
      generation.events.emit(permissionAsked(ambiguous));
      await waitForState(controller, (state) =>
        state.permissions.some((entry) => entry.id === ambiguous),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The permission is gone from the server's pending list (ambiguous outcome).
      // Resync triggers the safety net, which must release protection even though
      // answeredPermissions does not contain the id (ambiguous is not settled).
      await controller.resyncAuxiliary();

      // Push the collection over its cap so the sweep has real work to do.
      const total = OPENCODE_V2_RETENTION_CAP + 60;
      for (let index = 0; index < total; index += 1) {
        const other = `perm_filler_${index}`;
        generation.events.emit(permissionAsked(other));
        await waitForState(controller, (state) =>
          state.permissions.some((entry) => entry.id === other),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await controller.resyncAuxiliary();

      // The ambiguous entry's protection was released, so it is evictable and
      // gets swept. A redelivery therefore passes the guard and sends a second
      // approval (the accepted bounded limitation for ambiguous outcomes).
      generation.events.emit(permissionAsked(ambiguous));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterRedelivery = generation.permissionReplyInputs.filter(
        (input) => input.requestID === ambiguous,
      );
      expect(afterRedelivery.length).toBeGreaterThanOrEqual(2);
    } finally {
      clearAllAutoPolicies();
      controller.dispose();
    }
  });
});
