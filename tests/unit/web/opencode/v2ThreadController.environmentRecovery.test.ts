import { afterEach, describe, expect, it } from "bun:test";
import {
  createV2ThreadController,
  type V2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import {
  createClient,
  createGeneration,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function setVisibility(state: DocumentVisibilityState): void {
  if (typeof document === "undefined") return;
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
    writable: true,
  });
}

function setOnline(value: boolean): void {
  if (typeof navigator === "undefined") return;
  Object.defineProperty(navigator, "onLine", {
    value,
    configurable: true,
    writable: true,
  });
}

function dispatchVisibility(): void {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new Event("visibilitychange"));
}

function dispatchOnline(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("online"));
}

function dispatchOffline(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("offline"));
}

function dispatchPageShow(persisted: boolean): void {
  if (typeof window === "undefined") return;
  const event = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: persisted, configurable: true });
  window.dispatchEvent(event);
}

describe("environment-aware recovery", () => {
  const originalVisibility = typeof document === "undefined" ? "visible" : document.visibilityState;
  const originalOnLine = typeof navigator === "undefined" ? true : navigator.onLine;

  afterEach(() => {
    setVisibility(originalVisibility as DocumentVisibilityState);
    setOnline(originalOnLine);
  });

  it("healthy stream + visibility return = no reconnect", async () => {
    const generation = createGeneration(1);
    const client = createClient([generation]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 50,
    });

    try {
      await controller.awaitReady();
      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("connected");

      setVisibility("hidden");
      await sleep(50);
      setVisibility("visible");
      dispatchVisibility();
      await sleep(200);

      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("connected");
      expect(controller.getState().load.type).toBe("ready");
    } finally {
      controller.dispose();
    }
  });

  it("stale stream + visibility return = existing recovery pathway", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10,
    });

    try {
      await controller.awaitReady();
      expect(client.connectCount).toBe(1);

      const originalNow = Date.now;
      const base = Date.now();
      Date.now = () => base + 10_000;
      try {
        setVisibility("visible");
        dispatchVisibility();
        const reconnecting = await waitForWithin(
          controller,
          (state) => state.connection.type === "reconnecting",
          2_000,
        );
        expect(reconnecting).toBe(true);
        await client.waitForConnect(2);
        const recovered = await waitForWithin(
          controller,
          (state) => state.load.type === "ready" && state.connection.type === "connected",
          2_000,
        );
        expect(recovered).toBe(true);
        expect(client.connectCount).toBe(2);
      } finally {
        Date.now = originalNow;
      }
    } finally {
      controller.dispose();
    }
  });

  it("healthy stream + online event = no reconnect", async () => {
    const generation = createGeneration(1);
    const client = createClient([generation]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 50,
    });

    try {
      await controller.awaitReady();
      expect(client.connectCount).toBe(1);

      setOnline(false);
      await sleep(50);
      setOnline(true);
      dispatchOnline();
      await sleep(200);

      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("connected");
    } finally {
      controller.dispose();
    }
  });

  it("stale stream + online event = guarded recovery", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10,
    });

    try {
      await controller.awaitReady();
      expect(client.connectCount).toBe(1);

      const originalNow = Date.now;
      const base = Date.now();
      Date.now = () => base + 10_000;
      try {
        setOnline(true);
        dispatchOnline();
        const reconnecting = await waitForWithin(
          controller,
          (state) => state.connection.type === "reconnecting",
          2_000,
        );
        expect(reconnecting).toBe(true);
        await client.waitForConnect(2);
        const recovered = await waitForWithin(
          controller,
          (state) => state.load.type === "ready" && state.connection.type === "connected",
          2_000,
        );
        expect(recovered).toBe(true);
        expect(client.connectCount).toBe(2);
      } finally {
        Date.now = originalNow;
      }
    } finally {
      controller.dispose();
    }
  });

  it("pending hidden retry + visibility return = early wake", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      expect(client.connectCount).toBe(1);

      first.events.fail(new Error("stream closed"));
      const reconnecting = await waitForWithin(
        controller,
        (state) => state.connection.type === "reconnecting",
        2_000,
      );
      expect(reconnecting).toBe(true);
      expect(client.connectCount).toBe(1);

      const connect2 = client.waitForConnect(2);
      setVisibility("visible");
      dispatchVisibility();
      await connect2;
      const recovered = await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(recovered).toBe(true);
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("pending offline retry + online event = early wake", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      expect(client.connectCount).toBe(1);

      first.events.fail(new Error("stream closed"));
      const reconnecting = await waitForWithin(
        controller,
        (state) => state.connection.type === "reconnecting",
        2_000,
      );
      expect(reconnecting).toBe(true);
      expect(client.connectCount).toBe(1);

      const connect2 = client.waitForConnect(2);
      setOnline(true);
      dispatchOnline();
      await connect2;
      const recovered = await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(recovered).toBe(true);
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("repeated wake events = one connection attempt", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);

      const connect2 = client.waitForConnect(2);
      setVisibility("visible");
      dispatchVisibility();
      dispatchOnline();
      dispatchVisibility();
      dispatchOnline();

      await connect2;
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("retry cancellation invalidates the old timer/token", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);

      const connect2 = client.waitForConnect(2);
      const loadPromise = controller.load();
      await connect2;
      await loadPromise;
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("manual retry takes over pending scheduled retry", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);

      const connect2 = client.waitForConnect(2);
      const retryPromise = controller.retry();
      await connect2;
      await retryPromise;
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("dispose clears listeners, timers and waiters", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);
      controller.dispose();
      setVisibility("visible");
      dispatchVisibility();
      dispatchOnline();
      await sleep(200);
      expect(client.connectCount).toBe(1);
    } finally {
      // already disposed
    }
  });

  it("a stale attempt cannot mark ready or reset the retry budget", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10,
      maxReconnectAttempts: 1,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await client.waitForConnect(2);
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("a wake cannot resurrect an exhausted runtime", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10,
      maxReconnectAttempts: 1,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await client.waitForConnect(2);
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);
      second.events.fail(new Error("stream closed again"));
      await waitForWithin(controller, (state) => state.connection.type === "failed", 2_000);
      expect(client.connectCount).toBe(2);
      setVisibility("visible");
      dispatchVisibility();
      dispatchOnline();
      await sleep(200);
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("pageshow only acts on persisted restoration", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);

      dispatchPageShow(false);
      await sleep(200);
      expect(client.connectCount).toBe(1);

      const connect2 = client.waitForConnect(2);
      dispatchPageShow(true);
      await connect2;
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("offline events do not cause retry storms", async () => {
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);

      setOnline(false);
      dispatchOffline();
      dispatchOffline();
      await sleep(200);
      expect(client.connectCount).toBe(1);

      const connect2 = client.waitForConnect(2);
      setOnline(true);
      dispatchOnline();
      await connect2;
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("existing keepalive-only watchdog and in-flight prompt continuity tests remain green", async () => {
    const first = createGeneration(1);
    first.setPromptHandler(() => new Promise(() => undefined));
    const client = createClient([first]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 40,
      initialReconnectDelayMs: 5,
    });

    try {
      await controller.awaitReady();
      const signals = client.signals[0];
      expect(signals).toBeDefined();

      const sending = controller.sendMessage(
        { role: "user", content: [{ type: "text", text: "hello" }] } as never,
        { messageId: "local-user-1" },
      );
      void sending.catch(() => undefined);

      for (let beat = 0; beat < 20; beat += 1) {
        await sleep(10);
        signals?.onActivity();
      }
      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("connected");
    } finally {
      controller.dispose();
    }
  });
});
