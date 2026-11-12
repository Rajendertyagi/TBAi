/**
 * P4: prompt-admission capacity and backpressure, through the real controller.
 *
 * The store-level policy is covered in `promptsInFlight.test.ts`. These cases
 * exist to prove the DECISION the user sees: a prompt is refused BEFORE it is
 * dispatched, the refusal is reported as recoverable capacity rather than a
 * network/server failure, and the composer is re-enabled as soon as the slot
 * the refusal described actually exists.
 */

import { describe, expect, it } from "bun:test";
import type { SessionInboxUser } from "@opencode/client";
import { createPromptsInFlight } from "@web/features/opencode/sync/promptsInFlight.ts";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  deferred,
  userInbox,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const CAPACITY_POLICY = {
  softCap: 1,
  protectedCap: 1,
  hardCap: 1,
  ttlMs: 60_000,
} as const;

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("P4 prompt capacity backpressure", () => {
  it("refuses before dispatch and re-enables the composer once the slot exists", async () => {
    const generation = createGeneration(1);
    const response = deferred<SessionInboxUser>();
    const called = deferred<void>();
    generation.setPromptHandler(async () => {
      called.resolve(undefined);
      return response.promise;
    });
    const prompts = createPromptsInFlight(CAPACITY_POLICY);
    const controller = createV2ThreadController(
      createClient([generation]),
      { promptAdmissionTimeoutMs: 2_000 },
      {
        conversationId: "conv_capacity",
        fetchActivity: async () => "not-running",
        lifecycleStores: { prompts },
      },
    );

    try {
      await controller.awaitReady();

      // One prompt owns the single slot while its admission is unresolved.
      const first = controller.sendMessage(USER_MESSAGE, {
        messageId: "msg_cap_a",
        delivery: "steer",
      });
      await called.promise;
      await waitFor(() => controller.getProjection().capacity.backpressure);
      expect(controller.getProjection().isSendDisabled).toBe(true);
      expect(generation.promptInputs).toHaveLength(1);

      // The second send is refused by the registry, not by the server.
      await expect(
        controller.sendMessage(USER_MESSAGE, {
          messageId: "msg_cap_b",
          delivery: "steer",
        }),
      ).rejects.toMatchObject({ kind: "capacity-backpressure" });
      expect(generation.promptInputs).toHaveLength(1);
      expect(generation.interruptInputs).toHaveLength(0);

      // The only prompt settles: it becomes evictable, so the refusal's cause is
      // gone without any manual recovery step.
      response.resolve(userInbox("inbox_cap_a", "steer"));
      await expect(first).resolves.toEqual({
        messageId: "msg_cap_a",
        inboxId: "inbox_cap_a",
        delivery: "steer",
      });
      await waitFor(() => controller.getProjection().capacity.backpressure === false);
      expect(controller.getProjection().isSendDisabled).toBe(false);

      // The retry goes out, and the settled prompt is what made room.
      generation.setPromptHandler(async () => userInbox("inbox_cap_b", "steer"));
      await expect(
        controller.sendMessage(USER_MESSAGE, {
          messageId: "msg_cap_b",
          delivery: "steer",
        }),
      ).resolves.toEqual({
        messageId: "msg_cap_b",
        inboxId: "inbox_cap_b",
        delivery: "steer",
      });
      expect(generation.promptInputs).toHaveLength(2);
      expect(prompts.get("msg_cap_a")).toBeUndefined();
      expect(prompts.get("msg_cap_b")).toBeDefined();
    } finally {
      controller.dispose();
    }
  });

  it("reports a capacity refusal as recoverable, never as a network failure", async () => {
    const generation = createGeneration(1);
    const prompts = createPromptsInFlight(CAPACITY_POLICY);
    const controller = createV2ThreadController(
      createClient([generation]),
      { promptAdmissionTimeoutMs: 2_000 },
      {
        conversationId: "conv_capacity_error",
        fetchActivity: async () => "not-running",
        lifecycleStores: { prompts },
      },
    );

    try {
      await controller.awaitReady();
      // Fill the registry directly: a live, unanswerable prompt with no
      // protection still counts as in-flight (submitting is not evictable).
      expect(prompts.create(SESSION_ID, "msg_holder").ok).toBe(true);

      const error = await controller
        .sendMessage(USER_MESSAGE, { messageId: "msg_refused", delivery: "steer" })
        .then(
          () => null,
          (failure: unknown) => failure,
        );
      expect(error).toMatchObject({ kind: "capacity-backpressure" });
      if (error !== null && typeof error === "object" && "error" in error) {
        expect((error as { readonly error: { readonly kind?: unknown } }).error.kind).toBe(
          "capacity",
        );
      }
      expect(prompts.get("msg_refused")).toBeUndefined();
      expect(generation.promptInputs).toHaveLength(0);
      expect(generation.interruptInputs).toHaveLength(0);
    } finally {
      controller.dispose();
    }
  });
});
