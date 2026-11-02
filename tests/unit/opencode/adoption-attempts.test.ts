import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  OpenCodeAttemptSupersededError,
  OpenCodeContextInvalidatedError,
  OpenCodeNotReadyError,
  beginAttempt,
  beginShutdown,
  createDiscoveryProbeTransport,
  currentAttemptId,
  installAdoptedTarget,
  isAttemptActive,
  readConnectionState,
  readShutdownState,
  registerManagedChildStopProvider,
  resetConnectionStateForTests,
  setShutdownStateReaderForTests,
  type AdoptionAttempt,
  type ManagedChildStopProvider,
} from "@/services/opencode/connectionState.ts";
import {
  attemptOpenCodeAdoption,
  type AdoptionAttemptOutcome,
  type AdoptionRefusalReason,
} from "@/services/opencode/adoption.ts";
import { readOpenCodeRegistration } from "@/services/opencode/registration.ts";
import { REPO_ROOT } from "../../helpers/repo-root";
import { functionBody, stripComments } from "../../helpers/web/source-scope";

/**
 * AT1–AT11 — adoption attempt orchestration and the attempt lifecycle.
 *
 * AT12–AT17 belong to the managed-child coordinator in `serverManager` and land
 * with Phase D; AT3/AT5/AT6/AT7 likewise depend on the managed path and
 * revalidation. What is asserted here is the adopted half: one attempt identity
 * per cycle, supersession, the shutdown latch, the probe identity/version
 * checks and the guard's position.
 *
 * Every case uses disposable registration files and a stubbed `globalThis.fetch`
 * (resolved per invocation by the transport). No real OpenCode service, real
 * registration file or real password is read, and no process is signalled.
 */

const ORIGIN_A = "http://127.0.0.1:4201";
const ORIGIN_B = "http://127.0.0.1:4202";
const ORIGIN_EXISTING = "http://127.0.0.1:4203";
const PASSWORD = "adoption-fixture-password";
const EXISTING_PASSWORD = "adoption-existing-password";
const PID = 5150;
const VERSION = "2.2.0";

const realFetch = globalThis.fetch;
let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbai-opencode-adoption-"));
  resetConnectionStateForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetConnectionStateForTests();
  rmSync(root, { recursive: true, force: true });
});

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type Responder = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replaces the global fetch for one case and records every call by URL. */
function stubFetch(responder: Responder): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return responder(url, init);
  };
  globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
  return calls;
}

function readyResponse(pid = PID, version = VERSION): Response {
  return Response.json({ pid, version });
}

/**
 * One capability-route answer from an otherwise adoptable service. The event
 * route must really stream, because a JSON 200 there is `unknown`, not
 * `present` (B7) — a stub that answered JSON everywhere would be refused.
 */
function capabilityResponse(url: string): Response {
  if (url.endsWith("/api/event")) {
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(null, { status: 200 });
}

/** What an adoptable service answers: `/api/info` plus every capability route. */
function respondsLikeAdoptableService(url: string): Response {
  return url.endsWith(OPENCODE_CONFIG.readinessProbePath)
    ? readyResponse()
    : capabilityResponse(url);
}

function writeRecord(name: string, origin: string, pid = PID, version = VERSION): string {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify({ url: origin, pid, password: PASSWORD, version }));
  return file;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function expectRefused(outcome: AdoptionAttemptOutcome, reason: AdoptionRefusalReason): void {
  expect(outcome.status).toBe("refused");
  if (outcome.status === "refused") expect(outcome.reason).toBe(reason);
}

describe("AT1 — overlapping attempts, the older resolves last", () => {
  it("lets only the newer attempt install", async () => {
    const fileA = writeRecord("a.json", ORIGIN_A);
    const fileB = writeRecord("b.json", ORIGIN_B);
    const gateA = deferred<Response>();
    const calls = stubFetch((url) =>
      url.startsWith(ORIGIN_A) ? gateA.promise : respondsLikeAdoptableService(url),
    );

    const older = attemptOpenCodeAdoption({ path: fileA });
    await waitFor(() => calls.length === 1, "attempt A's probe");
    const newer = await attemptOpenCodeAdoption({ path: fileB });
    expect(newer.status).toBe("adopted");

    gateA.resolve(readyResponse());
    expectRefused(await older, "attempt_superseded");

    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN_B });
  });
});

describe("AT2 — the probe resolves after shutdown", () => {
  it("installs nothing and signals no adopted process", async () => {
    const file = writeRecord("a.json", ORIGIN_A);
    const gate = deferred<Response>();
    const calls = stubFetch(() => gate.promise);
    let enumerations = 0;
    const unregister = registerFakeStopProvider(() => {
      enumerations += 1;
      return [];
    });

    try {
      const pending = attemptOpenCodeAdoption({ path: file });
      await waitFor(() => calls.length === 1, "the probe request");
      await beginShutdown();

      gate.resolve(readyResponse());
      expectRefused(await pending, "shutdown");
    } finally {
      unregister();
    }

    expect(readConnectionState().target.mode).toBe("unresolved");
    // The request had already been initiated before shutdown; §1.9.4 lets it
    // complete on the wire. The adopted candidate is never signalled: the
    // provider is the managed-child owner and it was asked for zero stops.
    expect(calls).toHaveLength(1);
    expect(enumerations).toBe(1);
  });
});

/** Registers an empty managed-child stop provider for a case. */
function registerFakeStopProvider(
  enumerate: ManagedChildStopProvider["stopAllChildrenForShutdown"],
): () => void {
  return registerManagedChildStopProvider({ stopAllChildrenForShutdown: enumerate });
}

describe("AT4 — a probe fails for a superseded attempt", () => {
  it("leaves the current target unchanged", async () => {
    installAdoptedTarget({ origin: ORIGIN_EXISTING, password: EXISTING_PASSWORD });
    const fileA = writeRecord("a.json", ORIGIN_A);
    const fileB = writeRecord("b.json", ORIGIN_B);
    const gateA = deferred<Response>();
    const calls = stubFetch((url) =>
      url.startsWith(ORIGIN_A) ? gateA.promise : new Response("boom", { status: 500 }),
    );

    const older = attemptOpenCodeAdoption({ path: fileA });
    await waitFor(() => calls.length === 1, "attempt A's probe");
    expectRefused(await attemptOpenCodeAdoption({ path: fileB }), "probe_failed");

    gateA.resolve(new Response("nope", { status: 500 }));
    expectRefused(await older, "attempt_superseded");

    expect(readConnectionState().target).toMatchObject({
      mode: "adopted",
      origin: ORIGIN_EXISTING,
    });
  });
});

describe("AT8 — the guard is checked before the state replacement", () => {
  it("has no await between the guard and the single install call", () => {
    const source = stripComments(
      readFileSync(path.join(REPO_ROOT, "src/services/opencode/adoption.ts"), "utf8"),
    );
    const body = functionBody(source, "attemptOpenCodeAdoption");
    const guard = body.lastIndexOf("if (!isAttemptActive(attempt))");
    const install = body.indexOf("installAdoptedTarget(", guard);

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(guard);
    expect(body.slice(guard, install)).not.toContain("await");
  });
});

describe("AT9 — supersede aborts the older attempt", () => {
  it("aborts the older probe and leaves the newer attempt unaffected", async () => {
    const fileA = writeRecord("a.json", ORIGIN_A);
    const fileB = writeRecord("b.json", ORIGIN_B);
    const signals: (AbortSignal | null)[] = [];
    const calls = stubFetch((url, init) => {
      if (url.startsWith(ORIGIN_A)) {
        signals.push(init?.signal ?? null);
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return respondsLikeAdoptableService(url);
    });

    const older = attemptOpenCodeAdoption({ path: fileA });
    await waitFor(() => calls.length === 1, "attempt A's probe");

    expect((await attemptOpenCodeAdoption({ path: fileB })).status).toBe("adopted");
    expectRefused(await older, "attempt_superseded");

    expect(signals[0]?.aborted).toBe(true);
    expect(readConnectionState().target).toMatchObject({ origin: ORIGIN_B });
  });
});

describe("AT10 — discovery and the shutdown latch", () => {
  it("(a) begins a startup attempt without shutdown and with the current epoch", () => {
    const attempt = beginAttempt("startup");
    expect(currentAttemptId()).toBe(attempt.attemptId);
    expect(attempt.shutdownEpochAtStart).toBe(readShutdownState().shutdownEpoch);
    expect(isAttemptActive(attempt)).toBe(true);
  });

  it("(b) refuses after shutdown before any file operation, request or id advance", async () => {
    const file = writeRecord("a.json", ORIGIN_A);
    await beginShutdown();
    const before = currentAttemptId();
    const calls = stubFetch(() => readyResponse());

    const lstat = fs.lstat;
    const open = fs.open;
    let fileOperations = 0;
    fs.lstat = (async (...args: Parameters<typeof lstat>) => {
      fileOperations += 1;
      return lstat(...args);
    }) as typeof fs.lstat;
    fs.open = (async (...args: Parameters<typeof open>) => {
      fileOperations += 1;
      return open(...args);
    }) as typeof fs.open;

    try {
      expectRefused(await attemptOpenCodeAdoption({ path: file }), "shutdown");
    } finally {
      fs.lstat = lstat;
      fs.open = open;
    }

    expect(fileOperations).toBe(0);
    expect(calls).toHaveLength(0);
    expect(currentAttemptId()).toBe(before);
  });

  it("(c) the latch refuses under a matching epoch, before fetch and header construction", async () => {
    const attempt: AdoptionAttempt = beginAttempt("startup");
    const calls = stubFetch(() => readyResponse());
    setShutdownStateReaderForTests(() => ({
      shutdownEpoch: attempt.shutdownEpochAtStart,
      shutdownStarted: true,
    }));

    try {
      const transport = createDiscoveryProbeTransport(attempt, {
        origin: ORIGIN_A,
        password: PASSWORD,
      });
      await expect(transport(`${ORIGIN_A}/api/info`)).rejects.toBeInstanceOf(
        OpenCodeContextInvalidatedError,
      );
      expect(calls).toHaveLength(0);
      expect(attempt.controller.signal.aborted).toBe(false);
    } finally {
      setShutdownStateReaderForTests(null);
    }

    // This input is NOT reachable through the production API: `beginAttempt()`
    // refuses on the latch before it stamps an epoch, and only the seam can
    // report a matching epoch with `shutdownStarted: true` (§1.9.5).
    // Header construction happens after the gate in the transport; proven by
    // the source order rather than a builder spy.
    const httpSource = stripComments(
      readFileSync(path.join(REPO_ROOT, "src/services/opencode/http.ts"), "utf8"),
    );
    const gated = functionBody(httpSource, "createGatedTransport");
    expect(gated.indexOf("gate();")).toBeGreaterThan(-1);
    expect(gated.indexOf("buildEffectiveHeaders(")).toBeGreaterThan(gated.indexOf("gate();"));
  });

  it("(d) no candidate receives a request while the latch holds", async () => {
    const file = writeRecord("a.json", ORIGIN_A);
    await beginShutdown();
    const calls = stubFetch(() => readyResponse());
    expectRefused(await attemptOpenCodeAdoption({ path: file }), "shutdown");
    expect(calls).toHaveLength(0);
  });

  it("(e) an attempt created before shutdown is refused and its read stops", async () => {
    const file = writeRecord("a.json", ORIGIN_A);
    const attempt = beginAttempt("startup");
    expect(isAttemptActive(attempt)).toBe(true);

    await beginShutdown();
    expect(attempt.controller.signal.aborted).toBe(true);
    expect(isAttemptActive(attempt)).toBe(false);

    try {
      await readOpenCodeRegistration({ path: file, signal: attempt.controller.signal });
      throw new Error("expected the read to refuse");
    } catch (error) {
      expect((error as { refusal?: string }).refusal).toBe("registration_read_failed");
    }
  });
});

describe("AT11 — re-entrant supersession", () => {
  it("variant 1: a listener that begins an attempt supersedes the outer call", () => {
    const attemptA = beginAttempt("startup");
    let aAborts = 0;
    let nested: AdoptionAttempt | null = null;

    attemptA.controller.signal.addEventListener("abort", () => {
      aAborts += 1;
    });
    attemptA.controller.signal.addEventListener("abort", () => {
      nested = beginAttempt("manual");
    });

    let outerError: unknown;
    try {
      beginAttempt("startup");
    } catch (error) {
      outerError = error;
    }

    expect(outerError).toBeInstanceOf(OpenCodeAttemptSupersededError);
    expect(aAborts).toBe(1);
    expect(nested).not.toBeNull();
    expect(currentAttemptId()).toBe(nested?.attemptId ?? -1);
    expect(nested?.controller.signal.aborted).toBe(false);
    expect(isAttemptActive(attemptA)).toBe(false);
    if (nested !== null) expect(isAttemptActive(nested)).toBe(true);

    // A completion carrying the stale attempt installs nothing.
    expect(() =>
      installAdoptedTarget({ origin: ORIGIN_A, password: PASSWORD, attempt: attemptA }),
    ).toThrow(OpenCodeAttemptSupersededError);
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("variant 2: a listener that begins shutdown refuses the outer attempt", async () => {
    const attemptA = beginAttempt("startup");
    attemptA.controller.signal.addEventListener("abort", () => {
      void beginShutdown();
    });

    let outerError: unknown;
    try {
      beginAttempt("startup");
    } catch (error) {
      outerError = error;
    }

    expect(outerError).toBeInstanceOf(OpenCodeNotReadyError);
    expect(readShutdownState().shutdownStarted).toBe(true);
    expect(readShutdownState().shutdownEpoch).toBe(1);
    expect(attemptA.controller.signal.aborted).toBe(true);
    expect(() => beginAttempt("startup")).toThrow(OpenCodeNotReadyError);
  });
});

describe("BT4/BT7 — adoption-side refusals", () => {
  it("BT4: a missing registration makes no request", async () => {
    const calls = stubFetch(() => readyResponse());
    const outcome = await attemptOpenCodeAdoption({ path: path.join(root, "absent.json") });
    expectRefused(outcome, "registration_missing");
    expect(calls).toHaveLength(0);
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("BT7: a pid that differs from /api/info is refused with no install", async () => {
    const file = writeRecord("pid.json", ORIGIN_A);
    const calls = stubFetch(() => readyResponse(PID + 1));

    expectRefused(await attemptOpenCodeAdoption({ path: file }), "probe_identity_mismatch");
    expect(calls).toHaveLength(1);
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("adopts when the probe names the same pid and a supported version", async () => {
    const file = writeRecord("ok.json", ORIGIN_A);
    const calls = stubFetch((url) => respondsLikeAdoptableService(url));

    const outcome = await attemptOpenCodeAdoption({ path: file });
    expect(outcome.status).toBe("adopted");
    if (outcome.status === "adopted") {
      expect(outcome.capabilities).toEqual({
        version: VERSION,
        supported: {
          session: true,
          events: true,
          config: true,
          agent: true,
          model: true,
          command: true,
        },
      });
    }
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN_A });
    expect(calls[0]?.url).toBe(`${ORIGIN_A}${OPENCODE_CONFIG.readinessProbePath}`);
  });
});

describe("B7 — adoption is decided by the live build and its capabilities", () => {
  it("admits a newer stable build above the managed ceiling", async () => {
    const file = writeRecord("newer.json", ORIGIN_A);
    stubFetch((url) =>
      url.endsWith(OPENCODE_CONFIG.readinessProbePath)
        ? readyResponse(PID, "2.4.0")
        : capabilityResponse(url),
    );

    const outcome = await attemptOpenCodeAdoption({ path: file });
    expect(outcome.status).toBe("adopted");
    if (outcome.status === "adopted") expect(outcome.capabilities.version).toBe("2.4.0");
    expect(readConnectionState().target).toMatchObject({ mode: "adopted", origin: ORIGIN_A });
  });

  it("refuses an adopted service below 2.2.0 before capability probing", async () => {
    const file = writeRecord("below-minimum.json", ORIGIN_A, PID, "2.1.4");
    const calls = stubFetch((url) =>
      url.endsWith(OPENCODE_CONFIG.readinessProbePath)
        ? readyResponse(PID, "2.1.4")
        : capabilityResponse(url),
    );

    const outcome = await attemptOpenCodeAdoption({ path: file });
    expectRefused(outcome, "probe_version_unsupported");
    // Version rejection happens before capability probing
    expect(calls.map((call) => new URL(call.url).pathname)).not.toContain("/api/session");
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("refuses a prerelease build the live service reports, whatever the record says", async () => {
    const file = writeRecord("beta.json", ORIGIN_A);
    const calls = stubFetch((url) =>
      url.endsWith(OPENCODE_CONFIG.readinessProbePath)
        ? readyResponse(PID, "2.2.0-beta.1")
        : capabilityResponse(url),
    );

    expectRefused(await attemptOpenCodeAdoption({ path: file }), "probe_version_unsupported");
    // The version refusal happens before any capability route is read.
    expect(calls).toHaveLength(1);
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("adopts with a degraded snapshot when only an optional route is absent", async () => {
    const file = writeRecord("degraded.json", ORIGIN_A);
    stubFetch((url) =>
      url.endsWith("/api/config")
        ? new Response(null, { status: 404 })
        : respondsLikeAdoptableService(url),
    );

    const outcome = await attemptOpenCodeAdoption({ path: file });
    expect(outcome.status).toBe("adopted");
    if (outcome.status === "adopted") {
      expect(outcome.capabilities.supported).toMatchObject({
        session: true,
        events: true,
        config: false,
      });
    }
    // The snapshot travels with the installed target, so a later reader can
    // hide the settings surface without re-probing.
    expect(readConnectionState().target).toMatchObject({
      mode: "adopted",
      capabilities: { version: VERSION, supported: { config: false, session: true } },
    });
  });

  it("refuses an essential route that answers 404 and installs nothing", async () => {
    const file = writeRecord("no-session.json", ORIGIN_A);
    stubFetch((url) =>
      url.endsWith("/api/session")
        ? new Response(null, { status: 404 })
        : respondsLikeAdoptableService(url),
    );

    expectRefused(await attemptOpenCodeAdoption({ path: file }), "probe_capability_missing");
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("treats an unreadable essential route as a failed probe, not an absent capability", async () => {
    const file = writeRecord("event-not-stream.json", ORIGIN_A);
    stubFetch((url) =>
      url.endsWith("/api/event") ? Response.json({ ok: true }) : respondsLikeAdoptableService(url),
    );

    expectRefused(await attemptOpenCodeAdoption({ path: file }), "probe_failed");
    expect(readConnectionState().target.mode).toBe("unresolved");
  });
});

describe("explicit server endpoint adoption", () => {
  it("adopts an explicit endpoint from environment variables without requiring a service.json file", async () => {
    stubFetch((url) => respondsLikeAdoptableService(url));

    const outcome = await attemptOpenCodeAdoption({
      env: {
        OPENCODE_URL: ORIGIN_A,
        OPENCODE_PASSWORD: PASSWORD,
      },
    });

    expect(outcome.status).toBe("adopted");
    if (outcome.status === "adopted") {
      expect(outcome.registration.origin).toBe(ORIGIN_A);
      expect(outcome.registration.pid).toBe(PID);
      expect(outcome.registration.version).toBe(VERSION);
      expect(outcome.registration.path).toBe("config");
    }

    expect(readConnectionState().target).toMatchObject({
      mode: "adopted",
      origin: ORIGIN_A,
    });
  });

  it("refuses adoption when explicit server config carries no password", async () => {
    const outcome = await attemptOpenCodeAdoption({
      env: {
        OPENCODE_URL: ORIGIN_A,
      },
    });

    expectRefused(outcome, "missing_credential");
    expect(readConnectionState().target.mode).toBe("unresolved");
  });

  it("refuses adoption when explicit server endpoint is unreachable", async () => {
    stubFetch(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const outcome = await attemptOpenCodeAdoption({
      env: {
        OPENCODE_PORT: "4201",
        OPENCODE_PASSWORD: PASSWORD,
      },
    });

    expectRefused(outcome, "probe_failed");
    expect(readConnectionState().target.mode).toBe("unresolved");
  });
});
