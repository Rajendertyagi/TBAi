import { afterAll, afterEach, describe, expect, it, jest } from "bun:test";
import {
  createV2ThreadController,
  type V2ThreadController,
} from "@web/features/opencode/v2ThreadController.ts";
import {
  SESSION,
  createClient,
  createGeneration,
  deferred,
  waitForState,
} from "@web/testing/opencode/v2ThreadControllerHarness";

/**
 * This suite exercises browser-environment recovery (visibility/online/pageshow)
 * and must run in the main unit batch, which does not preload a DOM. Install a
 * minimal, test-local browser surface only when absent; never override an
 * existing DOM (e.g. dom-preload) and always restore globals after the file.
 */
type BrowserGlobalSnapshot = {
  hadWindow: boolean;
  hadDocument: boolean;
  windowValue: unknown;
  documentValue: unknown;
  navigatorOnLineDescriptor: PropertyDescriptor | undefined;
};

const browserGlobalSnapshot: BrowserGlobalSnapshot = {
  hadWindow: typeof (globalThis as { window?: unknown }).window !== "undefined",
  hadDocument: typeof (globalThis as { document?: unknown }).document !== "undefined",
  windowValue: (globalThis as { window?: unknown }).window,
  documentValue: (globalThis as { document?: unknown }).document,
  navigatorOnLineDescriptor:
    typeof navigator === "undefined"
      ? undefined
      : Object.getOwnPropertyDescriptor(navigator, "onLine"),
};

function ensureBrowserEnvironment(): void {
  if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    (globalThis as { window?: unknown }).window = new EventTarget();
  }
  if (typeof (globalThis as { document?: unknown }).document === "undefined") {
    (globalThis as { document?: unknown }).document = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
  }
  if (typeof navigator !== "undefined") {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
    if (!descriptor || descriptor.configurable || "value" in descriptor) {
      Object.defineProperty(navigator, "onLine", {
        value: descriptor && "value" in descriptor ? descriptor.value : true,
        configurable: true,
        writable: true,
      });
    }
  }
}

ensureBrowserEnvironment();

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("environment-aware recovery", () => {
  const originalVisibility = typeof document === "undefined" ? "visible" : document.visibilityState;
  const originalOnLine = typeof navigator === "undefined" ? true : navigator.onLine;

  afterEach(() => {
    setVisibility(originalVisibility as DocumentVisibilityState);
    setOnline(originalOnLine);
    jest.useRealTimers();
  });

  afterAll(() => {
    if (browserGlobalSnapshot.hadWindow) {
      (globalThis as { window?: unknown }).window = browserGlobalSnapshot.windowValue;
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
    if (browserGlobalSnapshot.hadDocument) {
      (globalThis as { document?: unknown }).document = browserGlobalSnapshot.documentValue;
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
    if (typeof navigator !== "undefined") {
      if (browserGlobalSnapshot.navigatorOnLineDescriptor) {
        Object.defineProperty(navigator, "onLine", browserGlobalSnapshot.navigatorOnLineDescriptor);
      } else {
        delete (navigator as { onLine?: unknown }).onLine;
      }
    }
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

  it("healthy stream + offline event = no abort and no reconnect", async () => {
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

      setOnline(false);
      dispatchOffline();
      await sleep(200);

      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("connected");
      expect(controller.getState().load.type).toBe("ready");
      expect(client.signals[0]?.connectionSignal.aborted).toBe(false);
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

  it("pending hidden retry + visibility return = early wake (hidden before failure, no unrelated wake)", async () => {
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

      setVisibility("hidden");
      setOnline(true);
      first.events.fail(new Error("stream closed"));
      const reconnecting = await waitForWithin(
        controller,
        (state) => state.connection.type === "reconnecting",
        2_000,
      );
      expect(reconnecting).toBe(true);
      expect(client.connectCount).toBe(1);

      // Unrelated events while hidden must not start the retry.
      dispatchVisibility(); // still hidden
      dispatchPageShow(false);
      await sleep(200);
      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("reconnecting");

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

  it("pending offline retry + online event = early wake (visibility/pageshow do not wake while offline)", async () => {
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

      setOnline(false);
      setVisibility("visible");
      first.events.fail(new Error("stream closed"));
      const reconnecting = await waitForWithin(
        controller,
        (state) => state.connection.type === "reconnecting",
        2_000,
      );
      expect(reconnecting).toBe(true);
      expect(client.connectCount).toBe(1);

      // While explicitly offline, visibility/pageshow must not accelerate retry.
      dispatchVisibility();
      dispatchPageShow(true);
      await sleep(200);
      expect(client.connectCount).toBe(1);
      expect(controller.getState().connection.type).toBe("reconnecting");

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
      setOnline(true);
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);

      const connect2 = client.waitForConnect(2);
      setVisibility("visible");
      dispatchVisibility();
      dispatchOnline();
      dispatchVisibility();
      dispatchOnline();
      dispatchPageShow(true);

      await connect2;
      await waitForWithin(
        controller,
        (state) => state.load.type === "ready" && state.connection.type === "connected",
        2_000,
      );
      await sleep(100);
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
    }
  });

  it("retry cancellation invalidates the old timer/token (manual load takeover)", async () => {
    jest.useFakeTimers();
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      // Keep the active replacement's idle watchdog well beyond the 15s retry-deadline
      // advancement so this test isolates retry-timer cancellation, not watchdog recovery.
      streamIdleTimeoutMs: 60_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      setOnline(true);
      first.events.fail(new Error("stream closed"));
      await flushMicrotasks();
      expect(controller.getState().connection.type).toBe("reconnecting");
      expect(client.connectCount).toBe(1);

      const connect2 = client.waitForConnect(2);
      const loadPromise = controller.load();
      await connect2;
      await loadPromise;
      expect(client.connectCount).toBe(2);
      expect(controller.getState().connection.type).toBe("connected");

      // Original retry deadline passes; cancelled timer/token must not start another attempt,
      // and the active replacement's idle watchdog must not fire during this interval.
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(controller.getState().connection.type).toBe("connected");
      expect(controller.getState().load.type).toBe("ready");
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
      jest.useRealTimers();
    }
  });

  it("manual retry takes over pending scheduled retry and invalidates original timer", async () => {
    jest.useFakeTimers();
    const first = createGeneration(1);
    const second = createGeneration(2);
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      // Keep the active replacement's idle watchdog well beyond the 15s retry-deadline
      // advancement so this test isolates retry-timer cancellation, not watchdog recovery.
      streamIdleTimeoutMs: 60_000,
      initialReconnectDelayMs: 10_000,
      maxReconnectDelayMs: 10_000,
    });

    try {
      await controller.awaitReady();
      setOnline(true);
      first.events.fail(new Error("stream closed"));
      await flushMicrotasks();
      expect(controller.getState().connection.type).toBe("reconnecting");

      const connect2 = client.waitForConnect(2);
      const retryPromise = controller.retry();
      await connect2;
      await retryPromise;
      expect(client.connectCount).toBe(2);
      expect(controller.getState().connection.type).toBe("connected");

      // Original retry deadline passes; cancelled timer/token must not start another attempt,
      // and the active replacement's idle watchdog must not fire during this interval.
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(controller.getState().connection.type).toBe("connected");
      expect(controller.getState().load.type).toBe("ready");
      expect(client.connectCount).toBe(2);
    } finally {
      controller.dispose();
      jest.useRealTimers();
    }
  });

  it("dispose clears listeners, timers and waiters (no restart after disposal)", async () => {
    jest.useFakeTimers();
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
      setOnline(true);
      first.events.fail(new Error("stream closed"));
      await flushMicrotasks();
      expect(controller.getState().connection.type).toBe("reconnecting");
      expect(client.connectCount).toBe(1);

      controller.dispose();

      // Environment events after disposal must not restart runtime.
      setVisibility("visible");
      dispatchVisibility();
      dispatchPageShow(true);
      setOnline(true);
      dispatchOnline();
      await flushMicrotasks();

      // Original retry deadline passes; cancelled timer must not reconnect.
      jest.advanceTimersByTime(15_000);
      await flushMicrotasks();
      expect(client.connectCount).toBe(1);
    } finally {
      // already disposed
      jest.useRealTimers();
    }
  });

  it("a stale attempt cannot mark ready or reset the retry budget (late session-read completion from superseded attempt)", async () => {
    setOnline(true);
    setVisibility("visible");
    const sessionReadStarted = deferred<void>();
    const sessionRead = deferred<typeof SESSION>();
    const first = createGeneration(1, {
      // Intentionally non-cooperative with abort: the deferred session read can resolve
      // after generation 1 is retired, exercising a real late session-read continuation.
      sessionGet: async () => {
        sessionReadStarted.resolve(undefined);
        return sessionRead.promise;
      },
    });
    const second = createGeneration(2, {
      // Generation 2 connects but fails hydration before becoming ready.
      sessionGet: async () => {
        throw new Error("generation 2 hydration failed");
      },
    });
    const client = createClient([first, second]);
    const controller = createV2ThreadController(client, {
      streamIdleTimeoutMs: 5_000,
      initialReconnectDelayMs: 10,
      maxReconnectAttempts: 1,
    });

    const loadPromise = controller.load();
    // Generation 1 is intentionally superseded and generation 2 exhausts retries; attach
    // handling so the superseded/terminal load promise cannot surface as unhandled.
    void loadPromise.catch(() => undefined);

    try {
      await sessionReadStarted.promise;
      expect(client.connectCount).toBe(1);

      // Fail generation 1 stream -> automatic recovery retires it and schedules retry.
      first.events.fail(new Error("stream closed"));
      await client.waitForConnect(2);

      // Generation 2 fails hydration before ready; maxReconnectAttempts: 1 => terminal exhausted.
      const exhausted = await waitForWithin(
        controller,
        (state) => state.connection.type === "failed" && state.load.type === "error",
        2_000,
      );
      expect(exhausted).toBe(true);
      expect(client.connectCount).toBe(2);
      const terminalState = controller.getState();

      // Only after generation 1 is retired and generation 2 exhausted the retry budget,
      // resolve generation 1's previously pending session read successfully.
      sessionRead.resolve(SESSION);
      await flushMicrotasks();
      await sleep(100);

      // Late session-read completion from superseded attempt must not dispatch its session,
      // mark ready, alter terminal failure, or reset the exhausted retry budget/start another connection.
      expect(controller.getState().load.type).toBe("error");
      expect(controller.getState().connection.type).toBe("failed");
      expect(controller.getState().load).toEqual(terminalState.load);
      expect(controller.getState().connection).toEqual(terminalState.connection);
      expect(client.connectCount).toBe(2);

      // Normal load() must still report terminal failure rather than opening a third connection.
      await expect(controller.load()).rejects.toBeDefined();
      await flushMicrotasks();
      await sleep(50);
      expect(controller.getState().load.type).toBe("error");
      expect(controller.getState().connection.type).toBe("failed");
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
      setOnline(true);
      dispatchOnline();
      dispatchPageShow(true);
      await sleep(200);
      expect(client.connectCount).toBe(2);
      expect(controller.getState().connection.type).toBe("failed");
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
      setOnline(true);
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

  it("offline/online transitions: pending retry not woken by visibility/pageshow while offline, wakes on online", async () => {
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
      setOnline(false);
      setVisibility("visible");
      first.events.fail(new Error("stream closed"));
      await waitForWithin(controller, (state) => state.connection.type === "reconnecting", 2_000);
      expect(client.connectCount).toBe(1);

      dispatchVisibility();
      dispatchPageShow(true);
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

  it("existing keepalive-only watchdog and in-flight prompt continuity remain green", async () => {
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
