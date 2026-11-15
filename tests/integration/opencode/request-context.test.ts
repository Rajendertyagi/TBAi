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
    const context = captureOpenCodeRequestContext();
    const calls = stubFetch(okResponder);

    await context.transport(`${ORIGIN_A}/api/info`);

    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).origin).toBe(ORIGIN_A);
    expect(passwordOf(calls[0]!.init)).toBe(PASSWORD);
    expect(context.mode).toBe("managed");
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

  it("invalidates captured contexts after shutdown begins", async () => {
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

  it("clears target to unresolved", () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    clearTarget();
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("shutdown is idempotent and shares completion", async () => {
    installManagedTarget({ baseUrl: ORIGIN_A, password: PASSWORD });
    const before = readConnectionState();
    const { provider, enumerations } = countingProvider([{ ok: true }]);
    const unregister = registerManagedChildStopProvider(provider);

    const first = beginShutdown();
    const second = beginShutdown();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ ok: true });
    expect(enumerations()).toBe(1);
    expect(readShutdownState().shutdownStarted).toBe(true);
    expect(readConnectionState().shutdownEpoch).toBe(before.shutdownEpoch + 1);

    unregister();
  });
});
