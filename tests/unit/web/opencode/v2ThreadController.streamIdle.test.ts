import { describe, expect, it } from "bun:test";
import {
  createV2ThreadController,
  type V2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import {
  LOCAL_MESSAGE_ID,
  USER_MESSAGE,
  createClient,
  createGeneration,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/**
 * RT-008: a silent stream is a failed stream, and silence is measured in BYTES.
 *
 * The pinned OpenCode 2.1.2 server sends an SSE keepalive comment every 15
 * seconds, so an idle-but-healthy stream is silent in EVENTS for as long as
 * nobody is working. The idle watchdog therefore listens for raw transport
 * activity (`onActivity`), and its threshold is two missed heartbeats.
 *
 * Both directions are pinned here:
 *
 * - keepalive-only activity must not reconnect, and
 * - a genuinely silent stream must reconnect - through the existing reconnect
 *   path, without retiring the runtime or cancelling work that is in flight.
 */

/** Small enough to observe without holding a stream open for 30 seconds. */
const IDLE_TIMEOUT_MS = 40;

/** One heartbeat interval for the test: comfortably below the threshold. */
const HEARTBEAT_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves `true` when the state predicate is met, `false` after `ms`.
 *
 * A missing reconnect is the regression this file exists to catch, so it must
 * FAIL the test rather than hang it: an unbounded wait for a state that never
 * arrives reports "slow" when the answer is "broken".
 */
async function waitForWithin(
  controller: V2ThreadController,
  predicate: (state: ReturnType<V2ThreadController["getState"]>) => boolean,
  ms: number,
): Promise<boolean> {
  return Promise.race([
    waitForState(controller, predicate).then(() => true),
    sleep(ms).then(() => false),
  ]);
}

describe("RT-008: the event stream idle watchdog", () => {
  it("stays connected when the only traffic is keepalives", async () => {
    const generation = createGeneration(1);
    const client = createClient([generation]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: IDLE_TIMEOUT_MS,
      initialReconnectDelayMs: 5,
    });

    try {
      await controller.awaitReady();
      const signals = client.signals[0];
      expect(signals).toBeDefined();

      // Five full idle windows of heartbeat-only traffic. An event-based
      // liveness rule would see "nothing happened" and reconnect; a
      // byte-based one sees a live stream.
      for (let beat = 0; beat < (IDLE_TIMEOUT_MS / HEARTBEAT_MS) * 5; beat += 1) {
        await sleep(HEARTBEAT_MS);
        signals?.onActivity();
      }

      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("connected");
      expect(controller.getState().load.type).toBe("ready");
    } finally {
      controller.dispose();
    }
  });

  it("reconnects a genuinely silent stream without retiring the runtime or cancelling in-flight work", async () => {
    const first = createGeneration(1);
    // A prompt that never answers: it is in flight when the stream goes
    // silent, and the idle abort must not target it.
    first.setPromptHandler(() => new Promise(() => undefined));
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: IDLE_TIMEOUT_MS,
      initialReconnectDelayMs: 5,
    });

    try {
      await controller.awaitReady();

      const sending = controller.sendMessage(USER_MESSAGE, { messageId: LOCAL_MESSAGE_ID });
      void sending.catch(() => undefined);

      // No activity is reported: the watchdog must route this through the
      // reconnect path, not through the terminal-failure path.
      const reconnecting = await waitForWithin(
        controller,
        (state) => state.connection.type === "reconnecting",
        2_000,
      );
      expect(reconnecting).toBe(true);
      expect(controller.getState().connection.type).not.toBe("failed");

      // The replacement attempt is scheduled through the existing backoff.
      await client.waitForConnect(2);
      expect(client.connectCount).toBe(2);

      // The connection was aborted; the runtime-lifetime signal - the one a
      // prompt is sent under - was not touched.
      expect(client.signals[0]?.connectionSignal.aborted).toBe(true);
      expect(client.signals[0]?.lifecycleSignal.aborted).toBe(false);

      const recovered = await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(recovered).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});
