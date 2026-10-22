/**
 * T14 - the retention policy is WIRED, not merely implemented.
 *
 * ## THE GAP THIS CLOSES
 *
 * `sync/retention.ts` is the policy, and `tests/unit/web/opencode/retention.test.ts`
 * covers the policy thoroughly - the cap, the TTL, the protection, and the
 * report when every entry is protected. What no test covered was the
 * **wiring**: that the controller actually keeps its long-lived collections in
 * a `RetentionSet`, and that the sweep actually runs.
 *
 * A policy that is implemented, tested, and never wired is a policy that does
 * nothing. So this file drives the **real controller** and asserts the
 * observable consequence:
 *
 * - the settled collections stay BOUNDED after many operations;
 * - an IN-FLIGHT entry SURVIVES the sweep - which is the whole point of the
 *   protection, because evicting it would let a second answer through for the
 *   same id (the defect M6 was).
 *
 * ## HOW THE SWEEP IS TRIGGERED
 *
 * The sweep runs on the auxiliary re-sync, which is the runtime's periodic
 * heartbeat (`applyAuxiliary` -> `sweepRetention`). So the test drives the
 * re-sync rather than reaching into the controller.
 */

import { describe, expect, it } from "bun:test";
import type { PermissionRequest } from "@opencode/client";
import { OPENCODE_V2_RETENTION_CAP } from "@web/features/opencode/config.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  createClient,
  createGeneration,
  waitForState,
  SESSION_ID,
  type PermissionReplyHandler,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/** A permission request the fake server can list. */
function permissionFor(id: string): PermissionRequest {
  return {
    id,
    sessionID: SESSION_ID,
    action: "bash",
    resource: "*.ts",
    metadata: {},
  } as unknown as PermissionRequest;
}

/**
 * The `permission.asked` event that puts a request on screen.
 *
 * The event's `data` IS the request, so it carries the request's own fields -
 * the reducer projects the request out of it, and a bare `{id}` would produce
 * a request with no action and no resources.
 */
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

describe("T14 - the controller's long-lived collections stay bounded", () => {
  it("evicts the oldest SETTLED permission ids once the collection is over its cap", async () => {
    // THE OBSERVABLE. The runtime filters a re-hydrated permission list
    // against the ids it has already answered (`answeredPermissions`), so an
    // id that is still HELD keeps its request out of the list, and an id that
    // was EVICTED lets its request come back.
    //
    // So the bound is observable without reaching into the controller: after
    // more answers than the cap allows, the OLDEST answered ids are the ones
    // that come back, and the NEWEST are the ones that do not. Without the
    // sweep, every answered id would still be held and NONE would come back -
    // which is the unbounded growth the policy exists to stop.
    const listed: PermissionRequest[] = [];
    const generation = createGeneration(1, {
      permissionList: async () => listed,
    });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      // Answer far more permissions than the cap allows. Each one lands in
      // `answeredPermissions`, the settled collection.
      const total = OPENCODE_V2_RETENTION_CAP + 60;
      const answered: string[] = [];
      for (let index = 0; index < total; index += 1) {
        const id = `perm_${index}`;
        listed.push(permissionFor(id));
        generation.events.emit(permissionAsked(id));
        await waitForState(controller, (state) => state.permissions.some((p) => p.id === id));
        await controller.replyToPermission(id, "once");
        answered.push(id);
      }

      // The sweep runs on the re-sync - the heartbeat that performs it.
      await controller.resyncAuxiliary();

      // The permissions the runtime now shows are the ones whose settled id
      // was EVICTED. The collection was over its cap, so the oldest settled
      // ids went.
      const resurfaced = new Set(controller.getState().permissions.map((p) => p.id));
      expect(resurfaced.size).toBeGreaterThan(0);

      // The OLDEST answered ids came back (they were evicted)...
      const oldest = answered[0];
      expect(resurfaced.has(oldest)).toBe(true);
      // ...and the NEWEST did not (they are still held).
      const newest = answered[answered.length - 1];
      expect(resurfaced.has(newest)).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it("never evicts an IN-FLIGHT permission, so a second answer cannot start", async () => {
    // THE POINT OF THE PROTECTION. A permission answer that is still in flight
    // holds a CLAIM, and the claim is protected: evicting it would let a
    // second answer through for the same id, which is exactly the defect M6
    // was.
    //
    // So ONE reply is made to HANG, and the sweep runs while it hangs. The
    // other replies resolve normally - the collection is filled by SETTLED
    // entries, and a settled entry is exactly what the sweep evicts.
    let releaseHeld = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const HELD_ID = "perm_in_flight";
    const replied: string[] = [];
    const permissionReply: PermissionReplyHandler = async (input) => {
      replied.push(input.requestID);
      if (input.requestID === HELD_ID) await held;
    };

    const generation = createGeneration(1, {
      permissionList: async () => [],
      permissionReply,
    });
    const controller = createV2ThreadController(createClient([generation]));

    try {
      await controller.awaitReady();

      // Arm the permission that will be held in flight.
      generation.events.emit(permissionAsked(HELD_ID));
      await waitForState(controller, (state) => state.permissions.some((p) => p.id === HELD_ID));

      // Start its reply. It hangs on the transport, so the claim is taken and
      // PROTECTED.
      const first = controller.replyToPermission(HELD_ID, "once");
      await waitForState(controller, () => replied.includes(HELD_ID));

      // Fill the collection well past its cap with SETTLED entries, while the
      // first answer is still in flight. Each settled permission lands in the
      // same collection the protected claim sits in, so the sweep has real
      // work to do.
      const total = OPENCODE_V2_RETENTION_CAP + 60;
      for (let index = 0; index < total; index += 1) {
        const other = `perm_other_${index}`;
        generation.events.emit(permissionAsked(other));
        await waitForState(controller, (state) => state.permissions.some((p) => p.id === other));
        await controller.replyToPermission(other, "once");
      }

      // The sweep runs on the re-sync (the heartbeat that performs it).
      await controller.resyncAuxiliary();

      // The SECOND answer for the still-in-flight id is REFUSED: the claim
      // survived the sweep. Without the protection it would have been evicted
      // with the settled entries, and this second reply would have produced a
      // SECOND transport call.
      await controller.replyToPermission(HELD_ID, "once");

      // Exactly ONE transport call for the in-flight id.
      expect(replied.filter((requestId) => requestId === HELD_ID)).toHaveLength(1);
      // And the collection really was over its cap, so the sweep had work to
      // do - otherwise this case would pass without proving anything.
      expect(replied.length).toBeGreaterThan(OPENCODE_V2_RETENTION_CAP);

      releaseHeld();
      await first;
    } finally {
      controller.dispose();
    }
  });
});
