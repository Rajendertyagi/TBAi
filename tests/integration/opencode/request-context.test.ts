import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  OpenCodeAttemptSupersededError,
  OpenCodeContextInvalidatedError,
  OpenCodeNotReadyError,
  beginAttempt,
  beginShutdown,
  captureOpenCodeRequestContext,
  clearTarget,
  createBoundedTransport,
  installAdoptedTarget,
  installManagedTarget,
  isAttemptActive,
  readConnectionState,
  readShutdownState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
  type OpenCodeShutdownResult,
  type OpenCodeAdoptedCredential,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeAuthScopeError, OpenCodeOriginMismatchError } from "@/services/opencode/http.ts";

/**
 * RC1–RC14 — capture/transition interleavings and shutdown revocation (§1.9.7).
 *
 * Every case interleaves at a real `await` boundary, and every transport is
 * driven by a substituted `globalThis.fetch`, so no server is contacted. The
 * cases that need a managed child stop inject a provider; `stopChild()` itself
 * is `serverManager`'s and its unit-level cases (RC15, RC16) belong to that
 * module's suite.
 *
 * RC6 (proxy) and RC7 (config read) are asserted once those paths obtain a
 * context; at this layer they would only restate RC1's transport property.
 */

const ORIGIN_A = "http://127.0.0.1:4101";
const ORIGIN_B = "http://127.0.0.1:4102";
const MANAGED_PASSWORD = "request-context-managed-password";
const ADOPTED_PASSWORD = "request-context-adopted-password";
const ROTATED_PASSWORD = "request-context-rotated-password";

const realFetch = globalThis.fetch;

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function stubFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return responder(input, init);
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  return calls;
}

function okResponder(): Response {
  return new Response("ok", { status: 200 });
}

function passwordOf(init: RequestInit | undefined): string | null {
  const header = new Headers(init?.headers).get("authorization");
  if (header === null) return null;
  const decoded = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
  return decoded.replace(/^opencode:/, "");
}

function originOf(call: CapturedCall): string {
  return new URL(call.url).origin;
}

/** A provider that records how many times shutdown enumerated its children. */
function countingProvider(results: readonly OpenCodeShutdownResult[]) {
  let enumerations = 0;
  const provider = {
    stopAllChildrenForShutdown(): readonly Promise<OpenCodeShutdownResult>[] {
      enumerations += 1;
      return results.map((result) => Promise.resolve(result));
    },
  };
  return { provider, enumerations: () => enumerations };
}

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConnectionStateForTests();
});

describe("RC1 — an ordinary transition after capture does not invalidate the context", () => {
  it("sends to the captured origin with the captured credential", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    const before = readConnectionState();
    const context = captureOpenCodeRequestContext();

    installAdoptedTarget({ origin: ORIGIN_B, password: ADOPTED_PASSWORD });
    const after = readConnectionState();

    const calls = stubFetch(okResponder);
    await context.transport(`${ORIGIN_A}/api/info`);

    expect(calls).toHaveLength(1);
    expect(originOf(calls[0]!)).toBe(ORIGIN_A);
    expect(passwordOf(calls[0]!.init)).toBe(MANAGED_PASSWORD);
    expect(context.credential.kind).toBe("managed");
    expect(context.baseUrl).toBe(ORIGIN_A);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.shutdownEpoch).toBe(before.shutdownEpoch);
  });
});

describe("RC2 — a transition before capture is reflected in the context", () => {
  it("captures the new target and the previous origin receives nothing", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    installAdoptedTarget({ origin: ORIGIN_B, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    const calls = stubFetch(okResponder);
    await context.transport(`${ORIGIN_B}/api/info`);

    expect(context.mode).toBe("adopted");
    expect(originOf(calls[0]!)).toBe(ORIGIN_B);
    expect(passwordOf(calls[0]!.init)).toBe(ADOPTED_PASSWORD);
    expect(calls.some((call) => originOf(call) === ORIGIN_A)).toBe(false);
    expect(context.shutdownEpoch).toBe(readShutdownState().shutdownEpoch);
  });
});

describe("RC3 — credential rotation", () => {
  it("keeps the old context on the old credential and the new capture on the new one", async () => {
    installAdoptedTarget({ origin: ORIGIN_A, password: ADOPTED_PASSWORD });
    const first = captureOpenCodeRequestContext();
    installAdoptedTarget({ origin: ORIGIN_A, password: ROTATED_PASSWORD });
    const second = captureOpenCodeRequestContext();

    expect(first.credential).not.toBe(second.credential);
    expect(passwordOf({ headers: first.authHeaders })).toBe(ADOPTED_PASSWORD);
    expect(passwordOf({ headers: second.authHeaders })).toBe(ROTATED_PASSWORD);

    const calls = stubFetch(okResponder);
    await first.transport(`${ORIGIN_A}/api/info`);
    await second.transport(`${ORIGIN_A}/api/info`);

    expect(passwordOf(calls[0]!.init)).toBe(ADOPTED_PASSWORD);
    expect(passwordOf(calls[1]!.init)).toBe(ROTATED_PASSWORD);
  });

  it("never sends an old credential to a different origin", async () => {
    installAdoptedTarget({ origin: ORIGIN_A, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();
    installAdoptedTarget({ origin: ORIGIN_A, password: ROTATED_PASSWORD });

    const calls = stubFetch(okResponder);
    await expect(context.transport(`${ORIGIN_B}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("RC4 — shutdown after capture, before send", () => {
  it("refuses initiation and reaches no origin", async () => {
    installAdoptedTarget({ origin: ORIGIN_A, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    await beginShutdown();

    const calls = stubFetch(okResponder);
    await expect(context.transport(`${ORIGIN_A}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeContextInvalidatedError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("RC5 — shutdown while a response is pending", () => {
  it("lets the issued request finish and refuses the next one", async () => {
    installAdoptedTarget({ origin: ORIGIN_A, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();

    let release!: (response: Response) => void;
    stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const issued = context.transport(`${ORIGIN_A}/api/info`);

    await beginShutdown();
    release(okResponder());
    await expect(issued).resolves.toHaveProperty("status", 200);

    await expect(context.transport(`${ORIGIN_A}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeContextInvalidatedError,
    );
    expect(() => captureOpenCodeRequestContext()).toThrow(OpenCodeNotReadyError);
  });
});

describe("RC8 — mismatched origin", () => {
  it("refuses a binding whose adopted credential belongs to another origin", () => {
    const credential: OpenCodeAdoptedCredential = Object.freeze({
      kind: "adopted",
      origin: ORIGIN_B,
      password: ADOPTED_PASSWORD,
    });

    expect(() =>
      createBoundedTransport({ origin: ORIGIN_A, credential, shutdownEpoch: 0 }),
    ).toThrow(OpenCodeAuthScopeError);
  });

  it("refuses a request for another origin before fetch and before header construction", async () => {
    let reads = 0;
    const credential: OpenCodeAdoptedCredential = Object.freeze({
      kind: "adopted",
      origin: ORIGIN_A,
      get password() {
        reads += 1;
        return ADOPTED_PASSWORD;
      },
    });
    const transport = createBoundedTransport({ origin: ORIGIN_A, credential, shutdownEpoch: 0 });
    const calls = stubFetch(okResponder);

    await expect(transport(`${ORIGIN_B}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(calls).toHaveLength(0);
    expect(reads).toBe(0);
  });
});

describe("RC9 — credential isolation, both directions", () => {
  it("never sends the managed password in adopted mode", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    installAdoptedTarget({ origin: ORIGIN_B, password: ADOPTED_PASSWORD });
    const context = captureOpenCodeRequestContext();
    const calls = stubFetch(okResponder);

    await context.transport(`${ORIGIN_B}/api/info`);

    expect(passwordOf(calls[0]!.init)).toBe(ADOPTED_PASSWORD);
    expect(passwordOf(calls[0]!.init)).not.toBe(MANAGED_PASSWORD);
  });

  it("never sends the adopted password in managed mode", async () => {
    installAdoptedTarget({ origin: ORIGIN_B, password: ADOPTED_PASSWORD });
    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    const context = captureOpenCodeRequestContext();
    const calls = stubFetch(okResponder);

    await context.transport(`${ORIGIN_A}/api/info`);

    expect(passwordOf(calls[0]!.init)).toBe(MANAGED_PASSWORD);
    expect(passwordOf(calls[0]!.init)).not.toBe(ADOPTED_PASSWORD);
  });
});

describe("RC10 — a superseded attempt cannot install or clear", () => {
  it("refuses the stale completion and leaves both counters untouched", () => {
    const stale = beginAttempt("startup");
    const current = beginAttempt("manual");
    expect(isAttemptActive(stale)).toBe(false);
    expect(stale.controller.signal.aborted).toBe(true);
    expect(isAttemptActive(current)).toBe(true);

    const before = readConnectionState();
    expect(() =>
      installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD, attempt: stale }),
    ).toThrow(OpenCodeAttemptSupersededError);
    expect(() => clearTarget(stale)).toThrow(OpenCodeAttemptSupersededError);
    const after = readConnectionState();

    expect(after.revision).toBe(before.revision);
    expect(after.shutdownEpoch).toBe(before.shutdownEpoch);
    expect(after.target.mode).toBe("unresolved");

    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD, attempt: current });
    expect(readConnectionState().target.mode).toBe("managed");
  });
});

describe("RC11 — revision and shutdownEpoch move for different jobs", () => {
  it("ordinary transitions move only the revision; shutdown moves the epoch once", async () => {
    const start = readConnectionState();

    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    const afterManaged = readConnectionState();
    installAdoptedTarget({ origin: ORIGIN_B, password: ADOPTED_PASSWORD });
    const afterAdopted = readConnectionState();
    clearTarget();
    const afterFallback = readConnectionState();
    installAdoptedTarget({ origin: ORIGIN_B, password: ROTATED_PASSWORD });
    const afterRotation = readConnectionState();

    expect(afterManaged.revision).toBe(start.revision + 1);
    expect(afterAdopted.revision).toBe(start.revision + 2);
    expect(afterFallback.revision).toBe(start.revision + 3);
    expect(afterRotation.revision).toBe(start.revision + 4);
    for (const state of [afterManaged, afterAdopted, afterFallback, afterRotation]) {
      expect(state.shutdownEpoch).toBe(start.shutdownEpoch);
    }

    await beginShutdown();
    const afterShutdown = readConnectionState();
    expect(afterShutdown.shutdownEpoch).toBe(start.shutdownEpoch + 1);
    expect(afterShutdown.revision).toBe(afterRotation.revision + 1);

    await beginShutdown();
    expect(readConnectionState().shutdownEpoch).toBe(afterShutdown.shutdownEpoch);
    expect(readConnectionState().revision).toBe(afterShutdown.revision);
  });
});

describe("RC12 — a retained install object cannot alter what is sent", () => {
  it("copies at installation and freezes every level", async () => {
    const installInput = { origin: ORIGIN_A, password: ADOPTED_PASSWORD };
    installAdoptedTarget(installInput);
    installInput.password = "mutated-after-install";

    const state = readConnectionState();
    if (state.target.mode !== "adopted") throw new Error("an adopted target was expected");
    const credential = state.target.credential;
    expect(credential.password).toBe(ADOPTED_PASSWORD);

    const context = captureOpenCodeRequestContext();
    expect(context.credential).toBe(credential);

    expect(() => {
      (context as { mode: string }).mode = "managed";
    }).toThrow(TypeError);
    expect(() => {
      (context.credential as { password: string }).password = "mutated-context";
    }).toThrow(TypeError);
    expect(() => Object.assign(context, { mode: "managed" })).toThrow(TypeError);
    expect(() => Object.defineProperty(context, "mode", { value: "managed" })).toThrow(TypeError);
    expect(() => Object.defineProperty(credential, "password", { value: "mutated" })).toThrow(
      TypeError,
    );

    const calls = stubFetch(okResponder);
    await context.transport(`${ORIGIN_A}/api/info`);
    expect(passwordOf(calls[0]!.init)).toBe(ADOPTED_PASSWORD);
  });
});

describe("RC13 — repeated shutdown", () => {
  it("moves the epoch once and shares one completion across sequential and concurrent callers", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    const before = readConnectionState();
    const attempt = beginAttempt("manual");
    const context = captureOpenCodeRequestContext();
    const { provider, enumerations } = countingProvider([{ ok: true }]);
    const unregister = registerManagedChildStopProvider(provider);

    const first = beginShutdown();
    const second = beginShutdown();
    const third = beginShutdown();
    const fourth = beginShutdown();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(fourth).toBe(first);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(Promise.all([third, fourth])).resolves.toEqual([{ ok: true }, { ok: true }]);

    expect(enumerations()).toBe(1);
    expect(attempt.controller.signal.aborted).toBe(true);

    const after = readConnectionState();
    expect(after.shutdownEpoch).toBe(before.shutdownEpoch + 1);
    expect(after.revision).toBe(before.revision + 1);

    // The attempt guard runs first; the latch is the second, independent refusal.
    expect(() =>
      installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD, attempt }),
    ).toThrow(OpenCodeAttemptSupersededError);
    expect(() => installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD })).toThrow(
      OpenCodeContextInvalidatedError,
    );
    expect(() => captureOpenCodeRequestContext()).toThrow(OpenCodeNotReadyError);

    const calls = stubFetch(okResponder);
    await expect(context.transport(`${ORIGIN_A}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeContextInvalidatedError,
    );
    expect(calls).toHaveLength(0);

    unregister();
  });
});

describe("RC14 — re-entrant shutdown", () => {
  it("publishes the completion before aborting, so a listener receives the same promise", async () => {
    installAdoptedTarget({ origin: ORIGIN_A, password: ADOPTED_PASSWORD });
    const before = readConnectionState();
    const attempt = beginAttempt("manual");
    const { provider, enumerations } = countingProvider([{ ok: true }]);
    const unregister = registerManagedChildStopProvider(provider);

    let observed: Promise<OpenCodeShutdownResult> | null = null;
    attempt.controller.signal.addEventListener("abort", () => {
      observed = beginShutdown();
    });

    const outer = beginShutdown();
    expect(observed).not.toBeNull();
    expect(observed).toBe(outer);
    await expect(outer).resolves.toEqual({ ok: true });

    expect(enumerations()).toBe(1);
    const after = readConnectionState();
    expect(after.shutdownEpoch).toBe(before.shutdownEpoch + 1);
    expect(after.revision).toBe(before.revision + 1);

    unregister();
  });

  it("settles as a typed failure when the stop provider throws synchronously", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: MANAGED_PASSWORD });
    const failure = new Error("provider refused to enumerate");
    const unregister = registerManagedChildStopProvider({
      stopAllChildrenForShutdown() {
        throw failure;
      },
    });

    await expect(beginShutdown()).resolves.toEqual({ ok: false, error: failure });

    unregister();
  });
});
