import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import type { OpenCodeDatabaseLease } from "@/services/opencode/ownership.ts";

const NO_DATABASE_LEASE: OpenCodeDatabaseLease = {
  acquire: async () => null,
  verifyChild: async () => undefined,
  release: () => undefined,
};

/**
 * Regression for M5 / §3-F: an old asynchronous registration removal must not
 * clear a newer registration published while the old removal was in flight.
 *
 * The registration module is mocked so removeOpenCodeRegistrationIfOwned can be
 * held on a deferred promise, making the interleaving deterministic without
 * real filesystem I/O.
 */

type Ownership = { path: string; pid: number; origin: string; id?: string };

let removeDeferred: {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} | null = null;
let published: Ownership[] = [];

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

mock.module("@/services/opencode/registration", () => ({
  writeOpenCodeRegistration: async (input: { origin: string; pid: number }) => {
    const record = { path: `reg-${input.pid}.json`, pid: input.pid, origin: input.origin };
    published.push(record);
    return record;
  },
  removeOpenCodeRegistrationIfOwned: async () => {
    const d = deferred();
    removeDeferred = d;
    return d.promise;
  },
}));

// Import AFTER the mock is registered so the module under test binds to it.
const { OpenCodeServerManager } = await import("@/services/opencode/serverManager.ts");

class RaceManager extends OpenCodeServerManager {
  constructor() {
    super(OPENCODE_CONFIG, NO_DATABASE_LEASE);
  }
  publish(pid: number): Promise<void> {
    return this.publishManagedRegistration({
      baseUrl: `http://127.0.0.1:${pid}`,
      pid,
      version: "2.2.6",
    });
  }
  remove(): Promise<boolean> {
    return this.removeOwnedRegistration();
  }
  getManagedPid(): number | null {
    return super.getManagedPid();
  }
}

beforeEach(() => {
  published = [];
  removeDeferred = null;
});

afterEach(() => {
  mock.restore();
});

describe("managed registration clear race (M5)", () => {
  it("an old removal finishing after a new publish does not clear the new registration", async () => {
    const manager = new RaceManager();

    // 1. Publish OLD registration.
    await manager.publish(1111);

    // 2. Start removal of OLD; it captures OLD and blocks on the deferred I/O.
    const oldRemoval = manager.remove();
    expect(removeDeferred).not.toBeNull();

    // 3. While the old removal is in flight, publish NEW.
    await manager.publish(2222);

    // 4. Let the old removal finish.
    removeDeferred!.resolve(true);
    await oldRemoval;

    // The NEW registration reference must survive: getManagedPid() must report
    // the NEW pid, not fall back to a launcher pid or null.
    expect(manager.getManagedPid()).toBe(2222);

    // A subsequent removal (as shutdown would do) must still be able to clean
    // up the NEW registration — proving the reference was not nulled.
    const shutdownRemoval = manager.remove();
    expect(removeDeferred).not.toBeNull();
    removeDeferred!.resolve(true);
    expect(await shutdownRemoval).toBe(true);
  });
});
