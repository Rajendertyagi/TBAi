import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useAvailabilityStore } from "@web/features/availability/availabilityStore.ts";
import {
  acquireRuntimeTargetEvents,
  releaseRuntimeTargetEvents,
  resetRuntimeTargetEventsForTests,
} from "@web/features/opencode/runtimeTargetEvents.ts";
import {
  resetRuntimeTargetStoreForTests,
  useRuntimeTargetStore,
} from "@web/features/opencode/runtimeStatus.ts";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitError(state: number = FakeEventSource.CONNECTING): void {
    this.readyState = state;
    this.onerror?.(new Event("error"));
  }

  emitTarget(identity: unknown): void {
    const event = { data: JSON.stringify(identity) } as MessageEvent;
    for (const listener of this.listeners.get("opencode.runtime_target") ?? []) {
      listener(event);
    }
  }
}

const nativeEventSource = globalThis.EventSource;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

let timers: Array<{ id: number; cb: () => void; delay: number; active: boolean }> = [];
let nextTimerId = 1;

function installFakeTimers(): void {
  timers = [];
  nextTimerId = 1;
  (globalThis as any).setTimeout = ((cb: () => void, delay?: number) => {
    const id = nextTimerId++;
    timers.push({ id, cb, delay: delay ?? 0, active: true });
    return id as any;
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((id: any) => {
    const timer = timers.find((t) => t.id === id);
    if (timer) timer.active = false;
    return nativeClearTimeout(id);
  }) as typeof clearTimeout;
}

function runNextTimer(): void {
  const timer = timers.find((t) => t.active);
  if (!timer) throw new Error("no active timer");
  timer.active = false;
  timer.cb();
}

function activeTimerDelays(): number[] {
  return timers.filter((t) => t.active).map((t) => t.delay);
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as any).EventSource = FakeEventSource;
  installFakeTimers();
  resetRuntimeTargetEventsForTests();
  resetRuntimeTargetStoreForTests();
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

afterEach(() => {
  resetRuntimeTargetEventsForTests();
  resetRuntimeTargetStoreForTests();
  (globalThis as any).EventSource = nativeEventSource;
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

describe("runtimeTargetEvents EventSource recovery", () => {
  it("uses browser-native retry while CONNECTING without creating duplicate sources", () => {
    acquireRuntimeTargetEvents();
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;

    es.emitError(FakeEventSource.CONNECTING);
    es.emitError(FakeEventSource.CONNECTING);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(activeTimerDelays()).toEqual([]);
    expect(es.closed).toBe(false);

    releaseRuntimeTargetEvents();
  });

  it("triggers controlled reconnection when CLOSED", () => {
    acquireRuntimeTargetEvents();
    const es = FakeEventSource.instances[0]!;
    es.emitError(FakeEventSource.CLOSED);

    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(activeTimerDelays()).toEqual([250]);

    runNextTimer();
    expect(FakeEventSource.instances).toHaveLength(2);

    releaseRuntimeTargetEvents();
  });

  it("retries constructor failure while active consumers remain with bounded backoff and single timer", () => {
    let attempts = 0;
    class ThrowingEventSource extends FakeEventSource {
      constructor(url: string) {
        attempts += 1;
        if (attempts <= 2) {
          throw new Error("constructor failed");
        }
        super(url);
      }
    }
    (globalThis as any).EventSource = ThrowingEventSource;

    acquireRuntimeTargetEvents();
    expect(attempts).toBe(1);
    expect(activeTimerDelays()).toEqual([250]);

    runNextTimer();
    expect(attempts).toBe(2);
    expect(activeTimerDelays()).toEqual([500]);

    runNextTimer();
    expect(attempts).toBe(3);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(activeTimerDelays()).toEqual([]);

    // A later CLOSED error should continue bounded backoff from prior attempts.
    FakeEventSource.instances[0]!.emitError(FakeEventSource.CLOSED);
    expect(activeTimerDelays()).toEqual([1000]);

    releaseRuntimeTargetEvents();
  });

  it("shares one connection across multiple consumers", () => {
    acquireRuntimeTargetEvents();
    acquireRuntimeTargetEvents();
    acquireRuntimeTargetEvents();
    expect(FakeEventSource.instances).toHaveLength(1);

    releaseRuntimeTargetEvents();
    expect(FakeEventSource.instances[0]!.closed).toBe(false);
    releaseRuntimeTargetEvents();
    expect(FakeEventSource.instances[0]!.closed).toBe(false);

    releaseRuntimeTargetEvents();
  });

  it("clears retries and closes the connection on last release", () => {
    acquireRuntimeTargetEvents();
    const es = FakeEventSource.instances[0]!;
    es.emitError(FakeEventSource.CLOSED);
    expect(activeTimerDelays()).toEqual([250]);

    releaseRuntimeTargetEvents();
    expect(activeTimerDelays()).toEqual([]);
    expect(es.closed).toBe(true);

    // No reconnect after final release.
    timers.forEach((t) => {
      t.active = false;
    });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("publishes latest identity snapshot on reconnection and duplicate/replayed events remain harmless", () => {
    acquireRuntimeTargetEvents();
    const es1 = FakeEventSource.instances[0]!;
    es1.emitOpen();
    es1.emitTarget({
      backendInstanceId: "b1",
      mode: "managed",
      targetRevision: 2,
      targetId: 2,
    });
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "b1",
      targetRevision: 2,
      targetId: 2,
    });

    es1.emitError(FakeEventSource.CLOSED);
    runNextTimer();
    const es2 = FakeEventSource.instances[1]!;
    es2.emitOpen();
    // Reconnection receives current/latest snapshot.
    es2.emitTarget({
      backendInstanceId: "b1",
      mode: "managed",
      targetRevision: 2,
      targetId: 2,
    });
    // Duplicate/replayed event is harmless.
    es2.emitTarget({
      backendInstanceId: "b1",
      mode: "managed",
      targetRevision: 2,
      targetId: 2,
    });
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "b1",
      targetRevision: 2,
      targetId: 2,
    });

    releaseRuntimeTargetEvents();
  });

  it("does not create retry storms on repeated errors", () => {
    acquireRuntimeTargetEvents();
    const es = FakeEventSource.instances[0]!;

    for (let i = 0; i < 10; i++) {
      es.emitError(FakeEventSource.CLOSED);
    }

    expect(activeTimerDelays()).toHaveLength(1);
    expect(activeTimerDelays()[0]).toBe(250);
    expect(FakeEventSource.instances).toHaveLength(1);

    runNextTimer();
    expect(FakeEventSource.instances).toHaveLength(2);
    const es2 = FakeEventSource.instances[1]!;
    for (let i = 0; i < 10; i++) {
      es2.emitError(FakeEventSource.CLOSED);
    }
    expect(activeTimerDelays()).toHaveLength(1);
    expect(activeTimerDelays()[0]).toBe(500);

    releaseRuntimeTargetEvents();
  });
});
