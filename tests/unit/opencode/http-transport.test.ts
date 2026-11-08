import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";
import { stripComments } from "../../helpers/web/source-scope";
import {
  OpenCodeContextInvalidatedError,
  beginShutdown,
  createBoundedTransport,
  readShutdownState,
  resetConnectionStateForTests,
  setShutdownStateReaderForTests,
  type OpenCodeAdoptedCredential,
} from "@/services/opencode/connectionState.ts";
import {
  OpenCodeOriginMismatchError,
  OpenCodeRedirectRefusedError,
} from "@/services/opencode/http.ts";

/**
 * TT1–TT6 — the bounded transport contract (§1.9.4).
 *
 * Every case drives the transport with a substituted `globalThis.fetch`, which
 * is resolved per invocation by design, so no module internals are poked and no
 * real server is contacted. "Header construction" is observed through a
 * credential whose `password` getter counts reads: the transport reads it only
 * while building the `Authorization` header, so a zero count proves no header
 * was built.
 */

const ORIGIN = "http://127.0.0.1:4096";
const MANAGED_PASSWORD = "bounded-transport-managed-password";
const CALLER_PASSWORD = "bounded-transport-caller-password";
const REDIRECT_SECRET = "bounded-transport-redirect-secret";

const realFetch = globalThis.fetch;

interface CapturedCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

/** Replaces the global fetch for one case and records every call. */
function stubFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return responder(input, init);
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  return calls;
}

/** A frozen adopted credential whose password reads are counted. */
function countingCredential(password: string, origin = ORIGIN) {
  let reads = 0;
  const credential: OpenCodeAdoptedCredential = Object.freeze({
    kind: "adopted",
    origin,
    get password() {
      reads += 1;
      return password;
    },
  });
  return { credential, reads: () => reads };
}

function expectedBasic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

function authorizationOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConnectionStateForTests();
});

describe("TT1 — origin normalization", () => {
  it("accepts the same origin with different case and a trailing slash in the binding", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const { credential } = countingCredential(MANAGED_PASSWORD, "http://localhost:4096");
    const transport = createBoundedTransport({
      origin: "HTTP://LocalHost:4096/",
      credential,
      shutdownEpoch: 0,
    });

    const response = await transport("http://localhost:4096/api/info");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(authorizationOf(calls[0]?.init)).toBe(expectedBasic(MANAGED_PASSWORD));
  });

  it("rejects a different host before any fetch or header construction", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const { credential, reads } = countingCredential(MANAGED_PASSWORD);
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: 0 });

    await expect(transport("http://127.0.0.1:4097/api/info")).rejects.toBeInstanceOf(
      OpenCodeOriginMismatchError,
    );
    expect(calls).toHaveLength(0);
    expect(reads()).toBe(0);
  });
});

describe("TT2 — caller Authorization is removed", () => {
  it("replaces a caller Authorization from init.headers with the bound credential", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const { credential } = countingCredential(MANAGED_PASSWORD);
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: 0 });

    await transport(`${ORIGIN}/api/info`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${CALLER_PASSWORD}`).toString("base64")}`,
        "x-directory": "scope",
      },
    });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(expectedBasic(MANAGED_PASSWORD));
    expect(headers.get("authorization")).not.toContain(CALLER_PASSWORD);
    expect(headers.get("x-directory")).toBe("scope");
  });
});

describe("TT3 — the initiation gate", () => {
  it("refuses after shutdown, before fetch and before header construction", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const { credential, reads } = countingCredential(MANAGED_PASSWORD);
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: 0 });

    await beginShutdown();

    await expect(transport(`${ORIGIN}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeContextInvalidatedError,
    );
    expect(calls).toHaveLength(0);
    expect(reads()).toBe(0);
  });

  it("refuses on the latch even when the epoch would still compare equal", async () => {
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const { credential, reads } = countingCredential(MANAGED_PASSWORD);
    const epoch = readShutdownState().shutdownEpoch;
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: epoch });

    // The production API cannot produce this state (§1.9.5): the latch is set
    // while the epoch an attempt carries still matches. The seam makes the
    // latch check constructible so it is tested rather than assumed.
    setShutdownStateReaderForTests(() => ({ shutdownEpoch: epoch, shutdownStarted: true }));
    try {
      await expect(transport(`${ORIGIN}/api/info`)).rejects.toBeInstanceOf(
        OpenCodeContextInvalidatedError,
      );
      expect(calls).toHaveLength(0);
      expect(reads()).toBe(0);
    } finally {
      setShutdownStateReaderForTests(null);
    }
  });
});

describe("TT4 — redirect refusal", () => {
  it("cancels the body and reports the status without leaking Location", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // No chunks: the body exists only to be cancelled.
      },
      cancel() {
        cancelled = true;
      },
    });
    const calls = stubFetch(
      () =>
        new Response(body, {
          status: 302,
          headers: { location: `http://evil.example/${REDIRECT_SECRET}` },
        }),
    );
    const { credential } = countingCredential(MANAGED_PASSWORD);
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: 0 });

    const error = await transport(`${ORIGIN}/api/info`).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(OpenCodeRedirectRefusedError);
    expect((error as OpenCodeRedirectRefusedError).status).toBe(302);
    expect((error as Error).message).not.toContain(REDIRECT_SECRET);
    expect((error as Error).message).not.toContain("evil.example");
    expect(cancelled).toBe(true);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("refuses a same-origin redirect too", async () => {
    stubFetch(() => new Response(null, { status: 307, headers: { location: `${ORIGIN}/moved` } }));
    const { credential } = countingCredential(MANAGED_PASSWORD);
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: 0 });

    await expect(transport(`${ORIGIN}/api/info`)).rejects.toBeInstanceOf(
      OpenCodeRedirectRefusedError,
    );
  });
});

describe("TT5 — Request inputs", () => {
  it("keeps non-auth headers from Request and init, and preserves method and body", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const request = new Request(`${ORIGIN}/session/ses_fixture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": "%2Ftmp%2Fworkspace",
        authorization: `Basic ${Buffer.from(`opencode:${CALLER_PASSWORD}`).toString("base64")}`,
      },
      body: payload,
    });
    const calls = stubFetch(() => new Response("ok", { status: 200 }));
    const { credential } = countingCredential(MANAGED_PASSWORD);
    const transport = createBoundedTransport({ origin: ORIGIN, credential, shutdownEpoch: 0 });

    await transport(request, { headers: { "x-init": "1" } });

    const captured = calls[0];
    if (captured === undefined) throw new Error("the transport never reached fetch");
    expect(captured.input).toBe(request);
    expect((captured.input as Request).method).toBe("POST");
    // fetch derives method and body from the Request; the transport must not
    // rewrite either into init.
    expect(captured.init?.method).toBeUndefined();
    expect(captured.init?.body).toBeUndefined();
    expect(await request.text()).toBe(payload);

    const headers = new Headers(captured.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-opencode-directory")).toBe("%2Ftmp%2Fworkspace");
    expect(headers.get("x-init")).toBe("1");
    expect(headers.get("authorization")).toBe(expectedBasic(MANAGED_PASSWORD));
  });
});

describe("TT6 — source scans", () => {
  function readStripped(relativePath: string): string {
    return stripComments(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
  }

  function sourceFilesUnder(root: string): string[] {
    const absolute = path.join(REPO_ROOT, root);
    return readdirSync(absolute).flatMap((entry) => {
      const child = path.join(absolute, entry);
      const relative = `${root}/${entry}`;
      if (statSync(child).isDirectory()) return sourceFilesUnder(relative);
      return entry.endsWith(".ts") ? [relative] : [];
    });
  }

  it("the transport, client and state modules construct no header themselves", () => {
    for (const file of [
      "src/services/opencode/http.ts",
      "src/services/opencode/client.ts",
      "src/services/opencode/connectionState.ts",
      "src/routes/opencode.ts",
    ]) {
      const source = readStripped(file);
      expect(source).not.toMatch(/Buffer\.from/);
      expect(source).not.toMatch(/\bBasic \$\{/);
      expect(source).not.toMatch(/base64/i);
    }
  });

  it("the Basic header has exactly one constructor on the OpenCode paths", () => {
    const runtime = readStripped("src/services/opencode/runtime.ts");
    expect(runtime.match(/Buffer\.from/g)).toHaveLength(1);
    expect(runtime.match(/`Basic \$\{/g)).toHaveLength(1);

    // Scoped to the OpenCode service and its HTTP boundary. `services/mcp`
    // has its own Basic credential for a different protocol (§1.8.4, P11).
    const sites = [...sourceFilesUnder("src/services/opencode"), "src/routes/opencode.ts"].filter(
      (file) => /Buffer\.from\([^)]*\)\.toString\("base64"\)/.test(readStripped(file)),
    );
    expect(sites).toEqual(["src/services/opencode/runtime.ts"]);
  });

  it("the shutdown-reader seam exists in exactly one production module", () => {
    const sites = sourceFilesUnder("src").filter((file) =>
      readStripped(file).includes("setShutdownStateReaderForTests"),
    );
    expect(sites).toEqual(["src/services/opencode/connectionState.ts"]);
  });
});
