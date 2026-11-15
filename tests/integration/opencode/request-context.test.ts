import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  OpenCodeContextInvalidatedError,
  OpenCodeNotReadyError,
  beginShutdown,
  captureOpenCodeRequestContext,
  clearTarget,
  createBoundedTransport,
  installManagedTarget,
  readConnectionState,
  readShutdownState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
  type OpenCodeShutdownResult,
} from "@/services/opencode/connectionState.ts";
import { OpenCodeOriginMismatchError } from "@/services/opencode/http.ts";

const ORIGIN_A = "http://127.0.0.1:4101";
const ORIGIN_B = "http://127.0.0.1:4102";
const PASSWORD = "request-context-password";

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

describe("managed request context", () => {
  it("captures the installed managed target and sends with its credential", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const before = readConnectionState();
    const context = captureOpenCodeRequestContext();

    installManagedTarget({ baseUrl: ORIGIN_B, password: PASSWORD });
    const after = readConnectionState();

    const calls = stubFetch(okResponder);
    await context.transport(`${ORIGIN_A}/api/info`);

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe(ORIGIN_A);
    expect(passwordOf(calls[0]!.init)).toBe(PASSWORD);
    expect(context.mode).toBe("managed");
    expect(after.revision).toBe(before.revision + 1);
    expect(after.shutdownEpoch).toBe(before.shutdownEpoch);
  });

  it("refuses requests to another origin", async () => {
    const transport = createBoundedTransport({
      origin: ORIGIN_A,
      credential: Object.freeze({ kind: "managed" as const, password: PASSWORD }),
      shutdownEpoch: 0,
    });
    const calls = stubFetch(okResponder);

    await expect(transport(`${ORIGIN_B}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses initiation after shutdown and reaches no origin", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const context = captureOpenCodeRequestContext();
    await beginShutdown();

    const calls = stubFetch(okResponder);
    await expect(context.transport(`${ORIGIN_A}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeContextInvalidatedError,
    );
    expect(calls).toHaveLength(0);
    expect(() => captureOpenCodeRequestContext()).toThrow(OpenCodeNotReadyError);
  });

  it("lets an issued request finish during shutdown and refuses the next one", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
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
  });

  it("moves revision for ordinary transitions and shutdown epoch once", async () => {
    const start = readConnectionState();

    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const afterManaged = readConnectionState();
    clearTarget();
    const afterClear = readConnectionState();
    installManagedTarget({ baseUrl: ORIGIN_B, password: PASSWORD });
    const afterRestore = readConnectionState();

    expect(afterManaged.revision).toBe(start.revision + 1);
    expect(afterClear.revision).toBe(start.revision + 2);
    expect(afterRestore.revision).toBe(start.revision + 3);
    for (const state of [afterManaged, afterClear, afterRestore]) {
      expect(state.shutdownEpoch).toBe(start.shutdownEpoch);
    }

    await beginShutdown();
    const afterShutdown = readConnectionState();
    expect(afterShutdown.shutdownEpoch).toBe(start.shutdownEpoch + 1);
    expect(afterShutdown.revision).toBe(afterRestore.revision + 1);

    await beginShutdown();
    expect(readConnectionState().shutdownEpoch).toBe(afterShutdown.shutdownEpoch);
    expect(readConnectionState().revision).toBe(afterShutdown.revision);
  });

  it("copies and freezes captured context and target state", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const state = readConnectionState();
    if (state.target.mode !== "managed") throw new Error("managed target expected");
    const credential = state.target.credential;
    const context = captureOpenCodeRequestContext();

    expect(context.credential).toBe(credential);
    expect(() => {
      (context as { mode: string }).mode = "unresolved";
    }).toThrow(TypeError);
    expect(() => {
      (context.credential as { password: string }).password = "mutated";
    }).toThrow(TypeError);
    expect(() => Object.assign(context, { mode: "unresolved" })).toThrow(TypeError);
    expect(() => Object.defineProperty(credential, "password", { value: "mutated" })).toThrow(
      TypeError,
    );

    const calls = stubFetch(okResponder);
    await context.transport(`${ORIGIN_A}/api/info`);
    expect(passwordOf(calls[0]!.init)).toBe(PASSWORD);
  });

  it("clears target to unresolved", () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    clearTarget();
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("shutdown is idempotent, shares completion, and refuses new installs/captures", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const before = readConnectionState();
    const { provider, enumerations } = countingProvider([{ ok: true }]);
    const unregister = registerManagedChildStopProvider(provider);

    const first = beginShutdown();
    const second = beginShutdown();
    const third = beginShutdown();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(Promise.all([second, third])).resolves.toEqual([{ ok: true }, { ok: true }]);

    expect(enumerations()).toBe(1);
    expect(readShutdownState().shutdownStarted).toBe(true);
    expect(readConnectionState().shutdownEpoch).toBe(before.shutdownEpoch + 1);
    expect(() => installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD })).toThrow(
      OpenCodeContextInvalidatedError,
    );
    expect(() => captureOpenCodeRequestContext()).toThrow(OpenCodeNotReadyError);

    unregister();
  });

  it("publishes shutdown completion before aborting listeners and settles provider throw as typed failure", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
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
