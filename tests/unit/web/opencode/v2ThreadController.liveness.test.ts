/**
 * L9: refresh() and reconcileStagedRevert() must not commit state from a
 * superseded attempt. The guarded hydrate() path captures one generation and
 * checks isLive(live) after each await; these two paths used requireGeneration()
 * repeatedly with no liveness check, so a takeover mid-await could let a stale
 * result mutate the current attempt's state.
 */
import type { SessionInfo } from "@opencode/client";
import { describe, expect, it } from "bun:test";
import { createV2ThreadController } from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION,
  createClient,
  createGeneration,
  deferred,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

describe("attempt-liveness guards (L9)", () => {
  it("refresh() does not commit a stale session after a generation takeover", async () => {
    const staleSession = deferred<SessionInfo>();
    let sessionGetEntered = false;
    let sessionGetCalls = 0;
    const first = createGeneration(1, {
      sessionGet: () => {
        sessionGetCalls += 1;
        // Block only the refresh read (2nd+ call); let initial hydrate finish.
        if (sessionGetCalls >= 2) {
          sessionGetEntered = true;
          return staleSession.promise;
        }
        return Promise.resolve(SESSION);
      },
    });
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client);

    try {
      await controller.awaitReady();

      // Start refresh under generation 1; it pauses at sessionGet.
      const refreshP = controller.refresh();
      for (let i = 0; i < 100 && !sessionGetEntered; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(sessionGetEntered).toBe(true);

      // Take over to generation 2 while gen-1's session read is paused by
      // failing gen-1's event stream (the standard reconnect trigger).
      queueMicrotask(() => first.events.fail(new Error("event stream failed")));
      await client.waitForConnect(2);
      await waitForState(controller, (s) => s.load.type === "ready");

      // Resolve the stale gen-1 session read AFTER the takeover with a
      // distinguishable title. A stale commit would overwrite the live
      // session's title with this value.
      staleSession.resolve({ ...SESSION, title: "STALE-GEN1" } satisfies SessionInfo);
      await refreshP.catch(() => undefined);

      // The controller must remain on the live generation's state; the stale
      // session must not have been committed.
      const after = controller.getState();
      expect(after.load.type).toBe("ready");
      expect(after.session?.title).not.toBe("STALE-GEN1");
    } finally {
      staleSession.resolve(SESSION);
      controller.dispose();
    }
  });
});
