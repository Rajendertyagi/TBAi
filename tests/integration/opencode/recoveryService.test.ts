import { afterEach, describe, expect, it } from "bun:test";
import type { OpenCodeClient } from "@/services/opencode/client";
import type { OpenCodeRuntimeTargetChange } from "@/services/opencode/connectionState";
import {
  drainOpenCodeRecovery,
  filterRecoveryCandidatesByOwner,
  getOpenCodeRecoveryState,
  startOpenCodeRecovery,
  stopOpenCodeRecovery,
  type RecoveryDeps,
} from "@/services/opencode/recovery";

/** A minimal fake client recording the calls the service makes. */
function fakeClient(
  overrides: {
    messages?: unknown[];
    inbox?: unknown[];
    promptError?: { status: number };
    syntheticError?: { status: number };
  } = {},
) {
  const calls: string[] = [];
  const client = {
    message: {
      list: async () => ({
        data: overrides.messages ?? [],
        cursor: { previous: null, next: null },
      }),
    },
    session: {
      inbox: {
        list: async () => overrides.inbox ?? [],
        cancel: async () => {
          calls.push("cancel");
        },
      },
      prompt: async () => {
        calls.push("prompt");
        if (overrides.promptError) throw overrides.promptError;
      },
      synthetic: async () => {
        calls.push("synthetic");
        if (overrides.syntheticError) throw overrides.syntheticError;
      },
    },
  } as unknown as OpenCodeClient;
  return { client, calls };
}

function managedChange(targetId = 1): OpenCodeRuntimeTargetChange {
  return {
    backendInstanceId: "inst-1",
    targetRevision: 1,
    targetId,
    mode: "managed",
  };
}

/** Emit a managed target change and make it the current snapshot. */
function emitManaged(
  listeners: Array<(c: OpenCodeRuntimeTargetChange) => void>,
  state: { snapshot: OpenCodeRuntimeTargetChange },
  targetId = 1,
): void {
  const change = managedChange(targetId);
  state.snapshot = change;
  listeners[0]!(change);
}

function makeDeps(overrides: Partial<RecoveryDeps> & { client?: OpenCodeClient } = {}): {
  deps: RecoveryDeps;
  listeners: Array<(c: OpenCodeRuntimeTargetChange) => void>;
  state: { shutdown: boolean; installed: boolean; snapshot: OpenCodeRuntimeTargetChange };
} {
  const listeners: Array<(c: OpenCodeRuntimeTargetChange) => void> = [];
  const state = {
    shutdown: false,
    installed: true,
    // Start unresolved so the late-subscriber snapshot does not trigger a pass;
    // tests that want the boot pass emit a managed change explicitly.
    snapshot: {
      backendInstanceId: "inst-1",
      targetRevision: 0,
      targetId: null,
      mode: "unresolved" as const,
    },
  };
  const client = overrides.client ?? fakeClient().client;
  const deps: RecoveryDeps = {
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    snapshot: () => state.snapshot,
    isShutdown: () => state.shutdown,
    isManagedInstalled: () => state.installed,
    listCandidates: async () => [
      {
        id: "conv-1",
        opencodeSessionId: "ses-1",
        opencodeDirectory: null,
        opencodeServiceOwner: null,
      },
    ],
    makeClient: async () => client,
    sleep: async () => undefined,
    now: Date.now,
    newId: () => "msg_generated_stable",
    readSessionSignal: async () => ({ busy: false, idle: false }),
    waitGrace: async () => undefined,
    graceMs: {
      shutdownInterruption: 0,
      incompleteAssistant: 0,
      pendingInput: 0,
      projectedUser: 0,
    },
    ...overrides,
  };
  return { deps, listeners, state };
}

afterEach(() => {
  stopOpenCodeRecovery();
});

describe("recovery service lifecycle", () => {
  it("subscribes and handles an already-installed target via snapshot", async () => {
    const { client, calls } = fakeClient({
      messages: [{ id: "u1", type: "user", time: { created: 1 } }],
    });
    const { deps, listeners, state } = makeDeps({ client });
    state.snapshot = managedChange(1); // already-installed target at subscribe time
    expect(startOpenCodeRecovery(deps).started).toBe(true);
    expect(listeners.length).toBe(1);
    await drainOpenCodeRecovery();
    expect(calls).toContain("prompt");
  });

  it("is idempotent on a second start", () => {
    const { deps, listeners } = makeDeps();
    expect(startOpenCodeRecovery(deps).started).toBe(true);
    expect(startOpenCodeRecovery(deps).started).toBe(false);
    expect(listeners.length).toBe(1);
  });

  it("deduplicates by backend instance + target id", async () => {
    const { client, calls } = fakeClient({
      messages: [{ id: "u1", type: "user", time: { created: 1 } }],
    });
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(calls.filter((c) => c === "prompt").length).toBe(1);
  });

  it("ignores unresolved target changes", async () => {
    const { client, calls } = fakeClient({
      messages: [{ id: "u1", type: "user", time: { created: 1 } }],
    });
    const { deps, listeners } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    listeners[0]!({
      backendInstanceId: "inst-1",
      targetRevision: 2,
      targetId: null,
      mode: "unresolved",
    });
    await drainOpenCodeRecovery();
    expect(calls.length).toBe(0);
  });

  it("does not act when shutdown has started", async () => {
    const { client, calls } = fakeClient({
      messages: [{ id: "u1", type: "user", time: { created: 1 } }],
    });
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    state.shutdown = true;
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(calls.length).toBe(0);
  });

  it("does not act when the target is no longer installed", async () => {
    const { client, calls } = fakeClient({
      messages: [{ id: "u1", type: "user", time: { created: 1 } }],
    });
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    state.installed = false;
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(calls.length).toBe(0);
  });

  it("retries transient failures up to 3 total calls, then stops", async () => {
    let attempts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user", time: { created: 1 } }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => {
          attempts += 1;
          throw { status: 503 };
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(attempts).toBe(3);
  });

  it("does not retry a 409 conflict", async () => {
    let attempts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user", time: { created: 1 } }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => {
          attempts += 1;
          throw { status: 409 };
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(attempts).toBe(1);
  });

  it("stop clears state and unsubscribes", () => {
    const { deps, listeners } = makeDeps();
    startOpenCodeRecovery(deps);
    expect(stopOpenCodeRecovery()).toBe(true);
    expect(listeners.length).toBe(0);
    expect(getOpenCodeRecoveryState().started).toBe(false);
  });
});

describe("recovery correctness fixes", () => {
  // Defect 1: one stable id across retries; a lost first response must not
  // create a second synthetic.
  it("reuses one stable synthetic id across retries after a lost response", async () => {
    const ids: Array<string | null | undefined> = [];
    let calls = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "s1", type: "synthetic", metadata: { notice: "opencode-restart" } }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async (input: { id?: string | null }) => {
          ids.push(input.id);
          calls += 1;
          // First call is accepted by the server but the response is lost.
          if (calls === 1) throw new Error("network: response lost");
        },
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(calls).toBe(2);
    expect(ids[0]).toBe("s1");
    expect(ids[1]).toBe("s1"); // same id on retry — no second synthetic
  });

  it("mints one id before the first attempt when no prior synthetic exists", async () => {
    const ids: Array<string | null | undefined> = [];
    let calls = 0;
    const client = {
      message: {
        list: async () => ({
          data: [
            { id: "a1", type: "assistant" },
            { id: "u1", type: "user" },
          ],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async (input: { id?: string | null }) => {
          ids.push(input.id);
          calls += 1;
          if (calls === 1) throw new Error("network: response lost");
        },
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(calls).toBe(2);
    expect(ids[0]).toBe("msg_generated_stable");
    expect(ids[1]).toBe("msg_generated_stable");
  });

  // Defect 6: cancel + prompt share the 3-call budget.
  it("successful cancel followed by transient prompt failure stays within 3 total calls", async () => {
    let cancels = 0;
    let prompts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: {
          list: async () => [
            {
              id: "s-pending",
              type: "synthetic",
              delivery: "steer",
              payload: { metadata: { notice: "opencode-restart" } },
            },
            { id: "u1", type: "user", delivery: "steer" },
          ],
          cancel: async () => {
            cancels += 1;
          },
        },
        prompt: async () => {
          prompts += 1;
          if (prompts === 1) throw { status: 503 }; // transient on first prompt
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(cancels).toBe(1); // cancel succeeded once, never retried
    expect(prompts).toBe(2); // first prompt failed transient, second succeeded
    expect(cancels + prompts).toBeLessThanOrEqual(3);
  });

  // Defect 5: the 60s shutdown grace is reachable via a presence-based signal.
  it("uses the 60s shutdown grace when busy present and idle absent", async () => {
    const graceWaits: number[] = [];
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: 123, idle: undefined } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({
      client,
      readSessionSignal: async () => ({ busy: true, idle: false }),
      waitGrace: async (ms) => {
        graceWaits.push(ms);
      },
      graceMs: {
        shutdownInterruption: 60_000,
        incompleteAssistant: 30_000,
        pendingInput: 5_000,
        projectedUser: 5_000,
      },
    });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(graceWaits).toContain(60_000);
  });

  it("does not use shutdown grace when busy and idle are both present", async () => {
    const graceWaits: number[] = [];
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: 123, idle: 456 } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({
      client,
      readSessionSignal: async () => ({ busy: true, idle: true }),
      waitGrace: async (ms) => {
        graceWaits.push(ms);
      },
      graceMs: {
        shutdownInterruption: 60_000,
        incompleteAssistant: 30_000,
        pendingInput: 5_000,
        projectedUser: 5_000,
      },
    });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(graceWaits).not.toContain(60_000);
    expect(graceWaits).toContain(5_000); // projected-user grace
  });

  // Defect 4: ownership filtering.
  it("filters candidates by history ownership (local, legacy managed, remote, unreadable)", () => {
    const candidates = [
      { id: "local", opencodeSessionId: "s1", opencodeDirectory: null, opencodeServiceOwner: null },
      {
        id: "legacy-managed",
        opencodeSessionId: "s2",
        opencodeDirectory: null,
        opencodeServiceOwner: "managed",
      },
      {
        id: "legacy-adopted-loopback",
        opencodeSessionId: "s3",
        opencodeDirectory: null,
        opencodeServiceOwner: "adopted:http://127.0.0.1:1234",
      },
      {
        id: "remote",
        opencodeSessionId: "s4",
        opencodeDirectory: null,
        opencodeServiceOwner: "remote:http://example.com:4000",
      },
      {
        id: "unreadable",
        opencodeSessionId: "s5",
        opencodeDirectory: null,
        opencodeServiceOwner: "not-a-valid-owner",
      },
    ];
    const kept = filterRecoveryCandidatesByOwner(candidates);
    expect(kept.map((c) => c.id)).toEqual(["local", "legacy-managed", "legacy-adopted-loopback"]);
  });

  it("never sends a remote-owned candidate to the managed client", async () => {
    let prompted = false;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => {
          prompted = true;
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({
      client,
      listCandidates: async () => [
        {
          id: "remote",
          opencodeSessionId: "s4",
          opencodeDirectory: null,
          opencodeServiceOwner: "remote:http://example.com:4000",
        },
      ],
    });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(prompted).toBe(false);
  });
});

describe("recovery retry/timeout/grace/target regressions", () => {
  // A: cancellation retries must not consume the prompt's call.
  it("a cancel that succeeds on its last allowed retry still leaves a call for the prompt", async () => {
    let cancels = 0;
    let prompts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: {
          list: async () => [
            {
              id: "s-pending",
              type: "synthetic",
              delivery: "steer",
              payload: { metadata: { notice: "opencode-restart" } },
            },
            { id: "u1", type: "user", delivery: "steer" },
          ],
          cancel: async () => {
            cancels += 1;
            if (cancels === 1) throw { status: 503 }; // transient, then success on call 2
          },
        },
        prompt: async () => {
          prompts += 1;
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(cancels).toBe(2); // cancel used 2 of 3 calls (1 transient + 1 success)
    expect(prompts).toBe(1); // prompt still got its reserved call
  });

  // B: per-call timeout is enforced — assert the request signal actually
  // aborted and the pass settled within a bounded time (not via the drain's
  // separate 10s timeout). Read timeouts skip the candidate: no retry, no
  // resume action on unproven state.
  it("aborts a never-resolving read at the per-call timeout and skips the candidate", async () => {
    let listCalls = 0;
    let observedSignal: AbortSignal | undefined;
    let prompted = false;
    const client = {
      message: {
        list: async (_input: unknown, init?: { signal?: AbortSignal }) => {
          listCalls += 1;
          observedSignal = init?.signal;
          // Never resolves on its own; only the timeout signal can end it.
          return await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => {
          prompted = true;
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client, perCallTimeoutMs: 5 });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    const started = Date.now();
    await drainOpenCodeRecovery();
    const elapsed = Date.now() - started;
    // The request's signal was actually aborted by the timeout.
    expect(listCalls).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    // Settled well within the drain's 10s bound — the 5ms timeout fired.
    expect(elapsed).toBeLessThan(2_000);
    // Read timeout skips the candidate: no resume action on unproven state.
    expect(prompted).toBe(false);
  });

  it("retries a resume-operation timeout as transient within the 3-call budget", async () => {
    let promptCalls = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async (_input: unknown, init?: { signal?: AbortSignal }) => {
          promptCalls += 1;
          // Never resolves on its own; the per-call timeout ends each attempt.
          return await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client, perCallTimeoutMs: 5 });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    // Resume timeouts are transient and retried up to the 3-call maximum.
    expect(promptCalls).toBe(3);
  });

  // C: grace is recalculated after reclassification.
  it("waits the additional grace when the state escalates during the initial wait", async () => {
    const graceWaits: number[] = [];
    let scanCount = 0;
    const client = {
      message: {
        list: async () => {
          scanCount += 1;
          // First scan: projected user (5s grace). Later scans: user + incomplete
          // assistant (30s grace) — a longer grace is now required.
          const data =
            scanCount <= 1
              ? [{ id: "u1", type: "user" }]
              : [
                  { id: "a1", type: "assistant" },
                  { id: "u1", type: "user" },
                ];
          return { data, cursor: { previous: null, next: null } };
        },
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({
      client,
      waitGrace: async (ms) => {
        graceWaits.push(ms);
      },
      graceMs: {
        shutdownInterruption: 60_000,
        incompleteAssistant: 30_000,
        pendingInput: 5_000,
        projectedUser: 5_000,
      },
    });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    // 5s initial, then the remaining 25s for the newly-detected 30s state.
    expect(graceWaits).toContain(5_000);
    expect(graceWaits).toContain(25_000);
  });

  // D: managed-to-managed replacement cancels the old target's work.
  it("cancels in-flight work for the previous managed target on direct replacement", async () => {
    let aborted = false;
    let listCalls = 0;
    const client = {
      message: {
        list: async (_input: unknown, init?: { signal?: AbortSignal }) => {
          listCalls += 1;
          if (listCalls > 1) {
            // The replacement target's pass completes normally.
            return { data: [], cursor: { previous: null, next: null } };
          }
          // Only the first target's call hangs until aborted by replacement.
          return await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client, perCallTimeoutMs: 60_000 });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state, 1); // target 1 starts a hanging pass
    await Bun.sleep(20); // let the first pass reach the hanging call
    emitManaged(listeners, state, 2); // direct managed-to-managed replacement
    await drainOpenCodeRecovery();
    expect(aborted).toBe(true);
  });
});

describe("recovery retry-exhaustion outcomes", () => {
  // A: cancellation exhausts its retries → prompt never called, not recovered.
  it("failed cancellation stops the action and never wakes the user prompt", async () => {
    let cancels = 0;
    let prompts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: {
          list: async () => [
            {
              id: "s-pending",
              type: "synthetic",
              delivery: "steer",
              payload: { metadata: { notice: "opencode-restart" } },
            },
            { id: "u1", type: "user", delivery: "steer" },
          ],
          cancel: async () => {
            cancels += 1;
            throw { status: 503 }; // transient on every attempt
          },
        },
        prompt: async () => {
          prompts += 1;
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    // Cancel reserves one call for the prompt: max 2 cancel attempts (3 - 1).
    expect(cancels).toBe(2);
    expect(prompts).toBe(0); // failed cancel never proceeds to prompt
    expect(getOpenCodeRecoveryState().lastOutcome).toBe("failed");
  });

  // B: prompt exhausts its retries → failed, never recovered.
  it("prompt retry exhaustion reports failed, never recovered", async () => {
    let prompts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => {
          prompts += 1;
          throw { status: 503 }; // transient on every attempt
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(prompts).toBe(3); // full 3-call budget
    expect(getOpenCodeRecoveryState().lastOutcome).toBe("failed");
  });

  // C: synthetic exhausts its retries → failed, same id on every call.
  it("synthetic retry exhaustion reports failed and reuses one stable id", async () => {
    const ids: Array<string | null | undefined> = [];
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "s1", type: "synthetic", metadata: { notice: "opencode-restart" } }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async (input: { id?: string | null }) => {
          ids.push(input.id);
          throw { status: 503 }; // transient on every attempt
        },
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(ids.length).toBe(3); // full 3-call budget
    expect(new Set(ids).size).toBe(1); // same stable id on every attempt
    expect(ids[0]).toBe("s1");
    expect(getOpenCodeRecoveryState().lastOutcome).toBe("failed");
  });

  // D: successful operations remain successful.
  it("successful cancel then successful prompt reports recovered", async () => {
    let prompts = 0;
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "u1", type: "user" }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: {
          list: async () => [
            {
              id: "s-pending",
              type: "synthetic",
              delivery: "steer",
              payload: { metadata: { notice: "opencode-restart" } },
            },
            { id: "u1", type: "user", delivery: "steer" },
          ],
          cancel: async () => undefined,
        },
        prompt: async () => {
          prompts += 1;
        },
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(prompts).toBe(1);
    expect(getOpenCodeRecoveryState().lastOutcome).toBe("recovered");
  });

  it("successful synthetic reconciliation reports recovered", async () => {
    const client = {
      message: {
        list: async () => ({
          data: [{ id: "s1", type: "synthetic", metadata: { notice: "opencode-restart" } }],
          cursor: { previous: null, next: null },
        }),
      },
      session: {
        get: async () => ({ time: { busy: false, idle: false } }),
        inbox: { list: async () => [], cancel: async () => undefined },
        prompt: async () => undefined,
        synthetic: async () => undefined,
      },
    } as unknown as OpenCodeClient;
    const { deps, listeners, state } = makeDeps({ client });
    startOpenCodeRecovery(deps);
    emitManaged(listeners, state);
    await drainOpenCodeRecovery();
    expect(getOpenCodeRecoveryState().lastOutcome).toBe("recovered");
  });
});
