/**
 * G1/G2 tooling: the parts that decide whether a WebView origin observation is
 * evidence at all.
 *
 * The observations themselves are live (`scripts/verify-packaged-webview-origin.ts`
 * drives the packaged app through `tauri-driver`; `scripts/observe-dev-webview-origin.ts`
 * drives `tauri dev` through WebView2's DevTools protocol). What is checked HERE
 * is the logic that decides what an observation MEANS:
 *
 *   1. the configured `devUrl` is never accepted as the observed origin;
 *   2. every named failure stage fires for its own reason, and the recorded stage
 *      is the first one that actually failed;
 *   3. a packaged origin other than the documented `http://app.localhost` fails,
 *      and the constant cannot drift from `docs/architecture.md`;
 *   4. a packaged observation passes ONLY when the in-origin instance id was
 *      read, the direct `127.0.0.1` read produced one, and the two are equal —
 *      a missing id fails closed instead of weakening the claim;
 *   5. the uploaded artifact set is the five named files — never a data directory;
 *   6. a sanitized log cannot carry a credential-shaped value.
 *
 * The WebDriver and CDP payload parsers are exercised with real payload shapes,
 * so a protocol response that stops being understood fails a test rather than
 * being reported as an absent value.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitizeLogFile, sanitizeLogText } from "../../../scripts/lib/sanitize";
import {
  originOf,
  sequentialStages,
  tailText,
  writeEvidenceFile,
} from "../../../scripts/lib/webview-observation";
import {
  EXPECTED_PACKAGED_ORIGIN,
  type PackagedNavigation,
  type PackagedOriginInput,
  type PageReadResult,
  assessPackagedOrigin,
  awaitsNavigation,
  checkDriverBinary,
  parseExecuteResponse,
  parseIntegrityLevel,
  parseSessionResponse,
  parseWindowHandles,
  readOriginValue,
  readProbeValue,
  unloadedDocumentFailure,
  waitForNavigation,
} from "../../../scripts/verify-packaged-webview-origin";
import {
  type DevOriginInput,
  assessDevOrigin,
  attributeBackendLog,
  buildDebugPortOverlay,
  headText,
  instanceIdFromProbe,
  parseCdpTargets,
  parseEvaluateResponse,
  portOfOrigin,
  readDevConfiguration,
  selectDevTarget,
  selectLaunchMarkers,
} from "../../../scripts/observe-dev-webview-origin";
import { repoPath } from "../../helpers/repo-root";

/** One line exactly as the logger's file sink writes it. */
function logLine(entry: Record<string, unknown>): string {
  return JSON.stringify({
    ts: 1761483600000,
    time: "2026-10-26T12:00:00.000Z",
    level: "info",
    scope: "server",
    ...entry,
  });
}

/**
 * How a passing run reached the document: one read, no wait. Reachable only
 * because the page had already left `about:blank` when it was asked.
 */
function navigatedOnce(overrides: Partial<PackagedNavigation> = {}): PackagedNavigation {
  return {
    attempts: 1,
    elapsedMs: 12,
    timeoutMs: 60_000,
    timedOut: false,
    windowHandles: null,
    windowHandlesError: null,
    ...overrides,
  };
}

function packagedInput(overrides: Partial<PackagedOriginInput> = {}): PackagedOriginInput {
  return {
    appPath: "C:\\portable\\TBAi.exe",
    appExists: true,
    driver: { spawnError: null, exitCode: null },
    session: { id: "session-1", error: null },
    port: { value: 41234, error: null },
    script: {
      origin: EXPECTED_PACKAGED_ORIGIN,
      href: "http://app.localhost/",
      error: null,
      navigation: navigatedOnce(),
    },
    probe: { status: 200, body: JSON.stringify({ instanceId: "instance-a" }), error: null },
    directProbe: { status: 200, error: null },
    appInstanceId: "instance-a",
    ...overrides,
  };
}

function devInput(overrides: Partial<DevOriginInput> = {}): DevOriginInput {
  return {
    configuredDevUrl: "http://localhost:3000",
    configurationError: null,
    build: { ok: true, error: null },
    dev: { spawnError: null, exitedEarly: false, exitCode: null },
    cdp: { available: true, error: null },
    target: {
      url: "http://localhost:3000/",
      webSocketUrl: "ws://127.0.0.1:55000/devtools/page/1",
      seen: ["page http://localhost:3000/"],
    },
    evaluation: {
      origin: "http://localhost:3000",
      href: "http://localhost:3000/chat",
      title: "TBAi",
      error: null,
    },
    probe: { status: 200, body: JSON.stringify({ instanceId: "instance-a" }), error: null },
    backend: {
      booted: [{ instanceId: "instance-a", port: 3000 }],
      failed: [],
      unattributedFailures: [],
      otherLines: 0,
    },
    ...overrides,
  };
}

describe("sanitized uploads", () => {
  it("redacts an Authorization header and every credential-shaped value", () => {
    const log = [
      "GET /chat 200",
      "Authorization: Bearer sk-live-abcdef0123456789",
      "upstream replied apiKey=abc123secret",
      '{"token": "tok_9f8e7d6c5b4a", "expires": 60}',
      "password: hunter2",
      "GET /cb?access_token=xyz789&state=ok",
    ].join("\n");
    const sanitized = sanitizeLogText(log);
    expect(sanitized.text).toContain("Authorization: [REDACTED]");
    expect(sanitized.text).toContain("apiKey=[REDACTED]");
    expect(sanitized.text).toContain('"token": [REDACTED]');
    expect(sanitized.text).toContain("password: [REDACTED]");
    expect(sanitized.text).toContain("access_token=[REDACTED]&state=ok");
    expect(sanitized.text).not.toContain("sk-live");
    expect(sanitized.text).not.toContain("hunter2");
    expect(sanitized.text).not.toContain("tok_9f8e7d6c5b4a");
    expect(sanitized.text).toContain("GET /chat 200");
    expect(sanitized.redactions).toBeGreaterThanOrEqual(5);
  });

  it("redacts a bare provider key that has no key name in front of it", () => {
    const sanitized = sanitizeLogText("provider rejected sk-ant-api03-AAAABBBBCCCCDDDD");
    expect(sanitized.text).not.toContain("sk-ant-api03");
    expect(sanitized.text).toContain("[REDACTED]");
  });

  it("leaves ordinary diagnostics alone", () => {
    const log = "GET /api/server/instance 200 instanceId=deadbeef\nreadyz 200 after 812 ms";
    const sanitized = sanitizeLogText(log);
    expect(sanitized.text).toBe(log);
    expect(sanitized.redactions).toBe(0);
    expect(sanitized.truncatedChars).toBe(0);
  });

  it("keeps the tail when the log exceeds the cap, and says how much it dropped", () => {
    const sanitized = sanitizeLogText(`${"a".repeat(50)}TAIL`, 10);
    expect(sanitized.truncatedChars).toBe(44);
    expect(sanitized.text).toContain("44 characters omitted from the head");
    expect(sanitized.text.endsWith("aaaaaaTAIL")).toBe(true);
  });

  it("reports a missing log instead of writing an empty one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-sanitize-"));
    try {
      const destination = path.join(dir, "out.log");
      const result = sanitizeLogFile(path.join(dir, "absent.log"), destination);
      expect(result.written).toBe(false);
      expect(result.sourceExisted).toBe(false);
      expect(result.error).toContain("no log at");
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the sanitized copy of an existing log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-sanitize-"));
    try {
      const source = path.join(dir, "tbai.log");
      const destination = path.join(dir, "upload", "tbai.log");
      fs.writeFileSync(source, "Authorization: Bearer abcdefghijklmnop\nreadyz 200\n");
      const result = sanitizeLogFile(source, destination);
      expect(result.written).toBe(true);
      expect(result.sourceExisted).toBe(true);
      expect(fs.readFileSync(destination, "utf8")).toContain("Authorization: [REDACTED]");
      expect(fs.readFileSync(destination, "utf8")).not.toContain("abcdefghijklmnop");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared observation helpers", () => {
  it("asks a later stage only when every earlier one passed", () => {
    const summary = sequentialStages([
      { stage: "build" as const, failures: [] },
      { stage: "dev-start" as const, failures: ["exited"] },
      { stage: "evaluate" as const, failures: ["no origin"] },
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.stage).toBe("dev-start");
    // The evaluate stage was never reached, so its failure is not an observation.
    expect(summary.failures).toEqual(["exited"]);
  });

  it("reports every failure of the stage that stopped the run", () => {
    const summary = sequentialStages([
      { stage: "build" as const, failures: ["build failed", "no stamp"] },
      { stage: "dev-start" as const, failures: ["exited"] },
    ]);
    expect(summary.stage).toBe("build");
    expect(summary.failures).toEqual(["build failed", "no stamp"]);
  });

  it("is ok when every stage passed", () => {
    const summary = sequentialStages([
      { stage: "build" as const, failures: [] },
      { stage: "dev-start" as const, failures: [] },
    ]);
    expect(summary).toEqual({ ok: true, stage: null, failures: [] });
  });

  it("treats an opaque or unparseable URL as no origin", () => {
    expect(originOf("http://localhost:3000/chat")).toBe("http://localhost:3000");
    expect(originOf("app://localhost")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf(null)).toBeNull();
  });

  it("tails text without inventing content", () => {
    expect(tailText("abcdef", 3)).toBe("def");
    expect(tailText("abc", 10)).toBe("abc");
  });

  it("writes evidence JSON with a trailing newline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-evidence-"));
    try {
      const file = path.join(dir, "nested", "evidence.json");
      const result = writeEvidenceFile(file, { ok: false, stage: "fetch" });
      expect(result.written).toBe(true);
      const text = fs.readFileSync(file, "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(JSON.parse(text)).toEqual({ ok: false, stage: "fetch" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("G1 packaged origin: protocol payloads", () => {
  it("reads a created session", () => {
    const parsed = parseSessionResponse(
      JSON.stringify({ value: { sessionId: "s-1", capabilities: { browserName: "wry" } } }),
    );
    expect(parsed.sessionId).toBe("s-1");
    expect(parsed.capabilities).toEqual({ browserName: "wry" });
    expect(parsed.error).toBeNull();
  });

  it("surfaces a refused session with the driver's message", () => {
    const parsed = parseSessionResponse(
      JSON.stringify({ value: { error: "session not created", message: "no such executable" } }),
    );
    expect(parsed.sessionId).toBeNull();
    expect(parsed.error).toContain("no such executable");
  });

  it("rejects an unreadable session body", () => {
    expect(parseSessionResponse("<html>bad gateway</html>").error).toContain("no readable session");
    expect(parseSessionResponse(JSON.stringify({ value: "unexpected" })).error).toContain(
      "no session object",
    );
  });

  it("reads a script value and surfaces a command error", () => {
    const ok = parseExecuteResponse(JSON.stringify({ value: { origin: "http://app.localhost" } }));
    expect(ok.value).toEqual({ origin: "http://app.localhost" });
    expect(ok.error).toBeNull();

    const failed = parseExecuteResponse(
      JSON.stringify({ value: { error: "javascript error", message: "blocked by CSP" } }),
    );
    expect(failed.value).toBeNull();
    expect(failed.error).toContain("blocked by CSP");
  });

  it("extracts only typed fields from the page and the in-origin probe", () => {
    expect(
      readOriginValue({ origin: "http://app.localhost", href: "http://app.localhost/", title: 7 }),
    ).toEqual({ origin: "http://app.localhost", href: "http://app.localhost/", title: null });
    expect(readOriginValue("http://app.localhost")).toEqual({
      origin: null,
      href: null,
      title: null,
    });
    expect(readProbeValue({ status: 200, body: '{"instanceId":"a"}' })).toEqual({
      status: 200,
      body: '{"instanceId":"a"}',
      error: null,
    });
    expect(readProbeValue({ fetchError: "TypeError: Failed to fetch" }).error).toContain(
      "in-origin fetch failed",
    );
  });
});

describe("G1 packaged origin: the failure matrix", () => {
  it("accepts a complete observation on the documented origin", () => {
    const assessed = assessPackagedOrigin(packagedInput());
    expect(assessed.failures).toEqual([]);
    expect(assessed.ok).toBe(true);
    expect(assessed.stage).toBeNull();
  });

  it("stops at session-create when the packaged app is missing", () => {
    const assessed = assessPackagedOrigin(
      packagedInput({
        appExists: false,
        driver: { spawnError: null, exitCode: null },
        session: { id: null, error: null },
      }),
    );
    expect(assessed.stage).toBe("session-create");
    expect(assessed.failures.join(" ")).toContain("does not exist");
    expect(assessed.failures.join(" ")).not.toContain("no session id");
  });

  it("stops at session-create when the driver is unavailable", () => {
    const assessed = assessPackagedOrigin(
      packagedInput({
        driver: { spawnError: "spawn tauri-driver ENOENT", exitCode: null },
        session: { id: null, error: null },
      }),
    );
    expect(assessed.stage).toBe("session-create");
    expect(assessed.failures.join(" ")).toContain("ENOENT");
  });

  it("stops at port-wait when no port was written", () => {
    const assessed = assessPackagedOrigin(packagedInput({ port: { value: null, error: null } }));
    expect(assessed.stage).toBe("port-wait");
  });

  it("stops at executeScript when the WebView is not on the packaged origin", () => {
    const assessed = assessPackagedOrigin(
      packagedInput({
        script: {
          origin: "http://localhost:3000",
          href: "http://localhost:3000/",
          error: null,
          navigation: navigatedOnce(),
        },
      }),
    );
    expect(assessed.stage).toBe("executeScript");
    expect(assessed.failures.join(" ")).toContain("expected http://app.localhost");
  });

  it("stops at fetch when the in-origin read did not succeed", () => {
    const wrongStatus = assessPackagedOrigin(
      packagedInput({ probe: { status: 403, body: "", error: null } }),
    );
    expect(wrongStatus.stage).toBe("fetch");

    const noInstance = assessPackagedOrigin(
      packagedInput({ probe: { status: 200, body: "<html>error</html>", error: null } }),
    );
    expect(noInstance.stage).toBe("fetch");
    expect(noInstance.failures.join(" ")).toContain("no instanceId");

    // A whitespace id is malformed evidence, not an id that failed to match.
    const blankInstance = assessPackagedOrigin(
      packagedInput({
        probe: { status: 200, body: JSON.stringify({ instanceId: "   " }), error: null },
      }),
    );
    expect(blankInstance.stage).toBe("fetch");
    expect(blankInstance.failures.join(" ")).toContain("no instanceId");
    expect(blankInstance.failures.join(" ")).not.toContain("different server");

    const transport = assessPackagedOrigin(
      packagedInput({ probe: { status: null, body: null, error: "TypeError: Failed to fetch" } }),
    );
    expect(transport.stage).toBe("fetch");
  });

  it("fails when the in-origin read reached a different server", () => {
    const assessed = assessPackagedOrigin(packagedInput({ appInstanceId: "instance-b" }));
    expect(assessed.stage).toBe("fetch");
    expect(assessed.ok).toBe(false);
    const failures = assessed.failures.join(" ");
    expect(failures).toContain("identity verification failed");
    expect(failures).toContain("different server");
    // Both ids are named, so a mismatch is diagnosable from the artifact alone.
    expect(failures).toContain("instance-a");
    expect(failures).toContain("instance-b");
  });

  it("compares the ids exactly after trimming, so padding is not a difference", () => {
    // Both sides are JSON string values from their own server; surrounding
    // whitespace is not identity. Only an actual difference may fail.
    const padded = assessPackagedOrigin(packagedInput({ appInstanceId: "  instance-a\t" }));
    expect(padded.failures).toEqual([]);
    expect(padded.ok).toBe(true);
  });

  it("fails when the app's own instance id was never read", () => {
    // The old rule passed here: an in-origin 200 was accepted even though the
    // page's answer could not be attributed to the backend this launch started.
    const assessed = assessPackagedOrigin(
      packagedInput({
        appInstanceId: null,
        directProbe: { status: null, error: "connect ECONNREFUSED 127.0.0.1:41234" },
      }),
    );
    expect(assessed.stage).toBe("fetch");
    expect(assessed.ok).toBe(false);
    const failures = assessed.failures.join(" ");
    expect(failures).toContain("was not read from 127.0.0.1");
    expect(failures).toContain("ECONNREFUSED");
    // Nothing was compared, so reporting a mismatch would be a false diagnosis.
    expect(failures).not.toContain("different server");
  });

  it("treats a blank app-instance id as missing evidence, not as a mismatch", () => {
    for (const blank of ["", "   "]) {
      const assessed = assessPackagedOrigin(
        packagedInput({ appInstanceId: blank, directProbe: { status: 200, error: null } }),
      );
      expect(assessed.stage).toBe("fetch");
      expect(assessed.ok).toBe(false);
      expect(assessed.failures.join(" ")).toContain("was not read from 127.0.0.1");
      expect(assessed.failures.join(" ")).not.toContain("different server");
    }
  });

  it("names why the direct read produced no instance id", () => {
    const nonOk = assessPackagedOrigin(
      packagedInput({ appInstanceId: null, directProbe: { status: 503, error: null } }),
    );
    expect(nonOk.failures.join(" ")).toContain("returned 503");

    const unreadable = assessPackagedOrigin(
      packagedInput({ appInstanceId: null, directProbe: { status: 200, error: null } }),
    );
    expect(unreadable.failures.join(" ")).toContain("no usable instanceId");

    const notAttempted = assessPackagedOrigin(
      packagedInput({ appInstanceId: null, directProbe: { status: null, error: null } }),
    );
    expect(notAttempted.failures.join(" ")).toContain("not attempted");
  });

  it("stops at the first failed stage instead of reporting consequences as evidence", () => {
    const assessed = assessPackagedOrigin(
      packagedInput({
        session: { id: null, error: "the driver refused the session" },
        port: { value: null, error: null },
        script: { origin: null, href: null, error: null, navigation: navigatedOnce() },
      }),
    );
    expect(assessed.stage).toBe("session-create");
    // Without a session, "no port" and "no origin" were never observed.
    expect(assessed.failures).toEqual(["the driver refused the session"]);
  });
});

describe("G1 packaged origin: the wait for the document", () => {
  const blank = { origin: "null", href: "about:blank", title: "" };
  const loaded = { origin: EXPECTED_PACKAGED_ORIGIN, href: "http://app.localhost/", title: "TBAi" };

  function readerOf(reads: readonly unknown[]): () => Promise<PageReadResult> {
    let index = 0;
    return async () => {
      const next = reads[Math.min(index++, reads.length - 1)];
      if (typeof next === "string") return { read: null, error: next };
      return { read: readOriginValue(next), error: null };
    };
  }

  it("knows which documents have not loaded", () => {
    expect(awaitsNavigation("about:blank")).toBe(true);
    expect(awaitsNavigation("about:blank#x")).toBe(true);
    expect(awaitsNavigation("")).toBe(true);
    expect(awaitsNavigation(null)).toBe(true);
    expect(awaitsNavigation("http://app.localhost/")).toBe(false);
    expect(awaitsNavigation("http://localhost:3000/")).toBe(false);
  });

  it("re-reads a blank document instead of accepting it as the origin", async () => {
    // The measured failing sequence (run 40871453744): the read returned
    // about:blank, and the app navigated a moment later. One read captured the
    // race; the wait must not.
    const waited = await waitForNavigation(readerOf([blank, blank, loaded]), {
      timeoutMs: 5_000,
      pollMs: 1,
    });
    expect(waited.navigation.attempts).toBe(3);
    expect(waited.navigation.timedOut).toBe(false);
    expect(waited.read?.href).toBe("http://app.localhost/");

    const assessed = assessPackagedOrigin(
      packagedInput({
        script: {
          origin: waited.read?.origin ?? null,
          href: waited.read?.href ?? null,
          error: waited.error,
          navigation: waited.navigation,
        },
      }),
    );
    expect(assessed.ok).toBe(true);
  });

  it("would have failed on the first blank read alone, which is why the wait exists", () => {
    const single = assessPackagedOrigin(
      packagedInput({
        script: {
          origin: blank.origin,
          href: blank.href,
          error: null,
          navigation: navigatedOnce(),
        },
        probe: { status: null, body: null, error: null },
      }),
    );
    expect(single.ok).toBe(false);
    expect(single.stage).toBe("executeScript");
    // Not reported as a wrong origin: "null" is what a blank document has.
    expect(single.failures.join(" ")).not.toContain("expected http://app.localhost");
  });

  it("fails with the wait it made when the document never loads", async () => {
    const waited = await waitForNavigation(readerOf([blank]), { timeoutMs: 40, pollMs: 5 });
    expect(waited.navigation.timedOut).toBe(true);
    expect(waited.navigation.attempts).toBeGreaterThan(1);

    const message = unloadedDocumentFailure(waited.read?.href ?? null, waited.navigation);
    expect(message).toContain("still on about:blank");
    expect(message).toContain("40 ms");
    expect(message).toContain(`${waited.navigation.attempts} reads`);

    const assessed = assessPackagedOrigin(
      packagedInput({
        script: {
          origin: waited.read?.origin ?? null,
          href: waited.read?.href ?? null,
          error: waited.error,
          navigation: { ...waited.navigation, windowHandles: ["handle-1"] },
        },
        probe: { status: null, body: null, error: null },
      }),
    );
    expect(assessed.stage).toBe("executeScript");
    expect(assessed.failures.join(" ")).toContain("still on about:blank");
    // The handle count is what rules out a session attached to another window.
    expect(assessed.failures.join(" ")).toContain("1 window handle(s)");
  });

  it("stops waiting on a real origin, wrong or not, instead of burning the deadline", async () => {
    const wrong = await waitForNavigation(
      readerOf([
        { origin: "http://localhost:3000", href: "http://localhost:3000/", title: "TBAi" },
      ]),
      { timeoutMs: 5_000, pollMs: 1 },
    );
    expect(wrong.navigation.attempts).toBe(1);
    expect(wrong.navigation.timedOut).toBe(false);
  });

  it("stops on a read that failed instead of treating it as a slow load", async () => {
    const failed = await waitForNavigation(
      readerOf([blank, "the driver rejected the script: no such window"]),
      { timeoutMs: 5_000, pollMs: 1 },
    );
    expect(failed.navigation.attempts).toBe(2);
    expect(failed.navigation.timedOut).toBe(false);
    expect(failed.error).toContain("no such window");

    const assessed = assessPackagedOrigin(
      packagedInput({
        script: { origin: null, href: null, error: failed.error, navigation: failed.navigation },
        probe: { status: null, body: null, error: null },
      }),
    );
    expect(assessed.stage).toBe("executeScript");
    expect(assessed.failures).toEqual([failed.error]);
  });

  it("reads the window-handle list the driver reports", () => {
    expect(parseWindowHandles(JSON.stringify({ value: ["h1", "h2"] }))).toEqual({
      handles: ["h1", "h2"],
      error: null,
    });
    expect(parseWindowHandles(JSON.stringify({ value: [] }))).toEqual({ handles: [], error: null });
    expect(parseWindowHandles(JSON.stringify({ value: "h1" })).error).toContain("no window list");
    expect(parseWindowHandles("<html>nope</html>").error).toContain("no window list");
  });
});

describe("G2 development origin: configuration and CDP payloads", () => {
  it("reads the launch configuration without treating it as an observation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-conf-"));
    try {
      const conf = path.join(dir, "tauri.conf.json");
      fs.writeFileSync(
        conf,
        JSON.stringify({
          build: { beforeDevCommand: "bun run dev", devUrl: "http://localhost:3000" },
        }),
      );
      const read = readDevConfiguration(conf);
      expect(read.devUrl).toBe("http://localhost:3000");
      expect(read.beforeDevCommand).toBe("bun run dev");
      expect(read.error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a configuration with no devUrl and an unreadable one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-conf-"));
    try {
      const noUrl = path.join(dir, "no-url.json");
      fs.writeFileSync(noUrl, JSON.stringify({ build: { beforeDevCommand: "bun run dev" } }));
      expect(readDevConfiguration(noUrl).error).toContain("declares no build.devUrl");

      const broken = path.join(dir, "broken.json");
      fs.writeFileSync(broken, "{ not json");
      expect(readDevConfiguration(broken).error).toContain("broken.json");
      expect(readDevConfiguration(path.join(dir, "absent.json")).error).toContain("absent.json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses the DevTools target list and rejects anything else", () => {
    const targets = parseCdpTargets(
      JSON.stringify([
        {
          type: "page",
          url: "http://localhost:3000/",
          title: "TBAi",
          webSocketDebuggerUrl: "ws://127.0.0.1:55000/devtools/page/1",
        },
        { type: "page", url: "about:blank" },
      ]),
    );
    expect(targets).toHaveLength(2);
    expect(targets?.[0].webSocketDebuggerUrl).toBe("ws://127.0.0.1:55000/devtools/page/1");
    expect(targets?.[1].webSocketDebuggerUrl).toBeNull();
    expect(parseCdpTargets("<html>nope</html>")).toBeNull();
    expect(parseCdpTargets(JSON.stringify({ targets: [] }))).toBeNull();
  });

  it("selects only a page target on the configured origin", () => {
    const configured = "http://localhost:3000";
    const targets = [
      { type: "page", url: "about:blank", title: null, webSocketDebuggerUrl: "ws://1/1" },
      {
        type: "page",
        url: "devtools://devtools/bundled/inspector.html",
        title: null,
        webSocketDebuggerUrl: "ws://1/2",
      },
      {
        type: "page",
        url: "http://localhost:3001/",
        title: null,
        webSocketDebuggerUrl: "ws://1/3",
      },
      {
        type: "page",
        url: "http://localhost:3000/chat/abc",
        title: "TBAi",
        webSocketDebuggerUrl: "ws://1/4",
      },
    ];
    expect(selectDevTarget(targets, configured)?.webSocketDebuggerUrl).toBe("ws://1/4");
    expect(selectDevTarget(targets, "http://localhost:9999")).toBeNull();
    expect(selectDevTarget(targets, null)).toBeNull();
    expect(
      selectDevTarget(
        [{ type: "page", url: "http://localhost:3000/", title: null, webSocketDebuggerUrl: null }],
        configured,
      ),
    ).toBeNull();
  });

  it("reads a Runtime.evaluate result, an exception and a protocol error", () => {
    const ok = parseEvaluateResponse({
      id: 1,
      result: { result: { type: "object", value: { origin: "http://localhost:3000" } } },
    });
    expect(ok.value).toEqual({ origin: "http://localhost:3000" });
    expect(ok.error).toBeNull();

    const threw = parseEvaluateResponse({
      id: 1,
      result: {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "TypeError: x is not defined" },
        },
      },
    });
    expect(threw.value).toBeNull();
    expect(threw.error).toContain("TypeError: x is not defined");

    const rejected = parseEvaluateResponse({
      id: 1,
      error: { code: -32601, message: "method not found" },
    });
    expect(rejected.value).toBeNull();
    expect(rejected.error).toContain("method not found");

    expect(parseEvaluateResponse("nope").error).toContain("not an object");
  });
});

describe("G2 development origin: the failure matrix", () => {
  it("accepts a complete observation when the page is on the configured origin", () => {
    const assessed = assessDevOrigin(devInput());
    expect(assessed.failures).toEqual([]);
    expect(assessed.ok).toBe(true);
    expect(assessed.stage).toBeNull();
  });

  it("stops at build when the bundle was not built", () => {
    const assessed = assessDevOrigin(
      devInput({ build: { ok: false, error: "the web build failed" } }),
    );
    expect(assessed.stage).toBe("build");
    expect(assessed.failures.join(" ")).toContain("web build failed");
  });

  it("stops at build when the configuration has no usable devUrl", () => {
    const assessed = assessDevOrigin(
      devInput({ configuredDevUrl: null, configurationError: "no build.devUrl" }),
    );
    expect(assessed.stage).toBe("build");
    expect(assessed.failures.join(" ")).toContain("no build.devUrl");
  });

  it("stops at dev-start when tauri dev exited before the observation", () => {
    const assessed = assessDevOrigin(
      devInput({ dev: { spawnError: null, exitedEarly: true, exitCode: 1 } }),
    );
    expect(assessed.stage).toBe("dev-start");
    expect(assessed.failures.join(" ")).toContain("exited with 1");
  });

  it("stops at cdp-unavailable when the DevTools endpoint never answered", () => {
    const assessed = assessDevOrigin(
      devInput({
        cdp: { available: false, error: "connection refused" },
        target: { url: null, webSocketUrl: null, seen: [] },
      }),
    );
    expect(assessed.stage).toBe("cdp-unavailable");
  });

  it("stops at target-list and names the targets it did see", () => {
    const assessed = assessDevOrigin(
      devInput({
        target: {
          url: null,
          webSocketUrl: null,
          seen: ["page about:blank", "page devtools://devtools/bundled/inspector.html"],
        },
      }),
    );
    expect(assessed.stage).toBe("target-list");
    expect(assessed.failures.join(" ")).toContain("about:blank");
  });

  it("stops at evaluate when the page's origin is not the configured devUrl", () => {
    const assessed = assessDevOrigin(
      devInput({
        evaluation: {
          origin: "http://localhost:5173",
          href: "http://localhost:5173/",
          title: "TBAi",
          error: null,
        },
      }),
    );
    expect(assessed.stage).toBe("evaluate");
    expect(assessed.failures.join(" ")).toContain("configured devUrl is http://localhost:3000");
    expect(assessed.failures.join(" ")).toContain("http://localhost:5173");
  });

  it("stops at probe-api when the page could not read the API", () => {
    const wrongStatus = assessDevOrigin(
      devInput({ probe: { status: 500, body: "", error: null } }),
    );
    expect(wrongStatus.stage).toBe("probe-api");

    const noInstance = assessDevOrigin(
      devInput({ probe: { status: 200, body: "<html>not this app</html>", error: null } }),
    );
    expect(noInstance.stage).toBe("probe-api");
    expect(noInstance.failures.join(" ")).toContain("no instanceId");

    const transport = assessDevOrigin(
      devInput({ probe: { status: null, body: null, error: "the expression threw: TypeError" } }),
    );
    expect(transport.stage).toBe("probe-api");
  });

  it("stops at dev-start when the development backend failed to start", () => {
    const assessed = assessDevOrigin(
      devInput({
        backend: {
          booted: [],
          failed: [
            { instanceId: "instance-a", reason: "Failed to start server. Is port 3000 in use?" },
          ],
          unattributedFailures: [],
          otherLines: 0,
        },
      }),
    );
    expect(assessed.stage).toBe("dev-start");
    expect(assessed.failures.join(" ")).toContain("instance-a");
    expect(assessed.failures.join(" ")).toContain("Is port 3000 in use?");
  });

  it("never blames this launch for a failure another process logged", () => {
    // The real condition: a second backend (the packaged sidecar) tried to bind
    // the dev port and failed, while the process serving the WebView started
    // cleanly. Shared log, two owners, one of them irrelevant to this evidence.
    const assessed = assessDevOrigin(
      devInput({
        backend: {
          booted: [{ instanceId: "instance-a", port: 3000 }],
          failed: [{ instanceId: "instance-b", reason: "EADDRINUSE: port 3000" }],
          unattributedFailures: [],
          otherLines: 0,
        },
      }),
    );
    expect(assessed.failures).toEqual([]);
    expect(assessed.ok).toBe(true);
    expect(assessed.stage).toBeNull();
    expect(assessed.notes.join(" ")).toContain("instance-b");
  });

  it("attributes a shared log file to the instance that answered before deciding", () => {
    const shared = [
      logLine({
        event: "started",
        message: "http://localhost:3000 data=C:\\tmp\\tbai-data",
        port: 3000,
        instanceId: "instance-a",
      }),
      logLine({
        event: "startup_failed",
        level: "error",
        message: "Failed to start server. Is port 3000 in use?",
        instanceId: "instance-b",
        stack: "at bindBootPort\nat startServer",
      }),
      "error: The process cannot access the file because it is being used by another process.",
    ].join("\n");
    const assessed = assessDevOrigin(devInput({ backend: attributeBackendLog(shared) }));
    expect(assessed.ok).toBe(true);
    expect(assessed.notes.join(" ")).toContain("instance-b");
    expect(assessed.notes.join(" ")).not.toContain("instance-a");
  });

  it("refuses the observation when the log has no start record for the answering instance", () => {
    const assessed = assessDevOrigin(
      devInput({
        backend: { booted: [], failed: [], unattributedFailures: [], otherLines: 0 },
      }),
    );
    expect(assessed.stage).toBe("dev-start");
    expect(assessed.failures.join(" ")).toContain("no successful start for instance instance-a");
  });

  it("refuses the observation when the answering instance bound another port", () => {
    const assessed = assessDevOrigin(
      devInput({
        backend: {
          booted: [{ instanceId: "instance-a", port: 3001 }],
          failed: [],
          unattributedFailures: [],
          otherLines: 0,
        },
      }),
    );
    expect(assessed.stage).toBe("dev-start");
    expect(assessed.failures.join(" ")).toContain("bound port 3001");
  });
});

describe("application-log attribution", () => {
  it("groups started and failed records by the instance that wrote them", () => {
    const text = [
      logLine({
        event: "started",
        message: "http://localhost:3000 data=D:\\d",
        port: 3000,
        instanceId: "dev-1",
      }),
      logLine({
        event: "startup_failed",
        level: "error",
        message: "EADDRINUSE: port 3000",
        instanceId: "sidecar-2",
      }),
      "not a log line",
    ].join("\n");
    expect(attributeBackendLog(text)).toEqual({
      booted: [{ instanceId: "dev-1", port: 3000 }],
      failed: [{ instanceId: "sidecar-2", reason: "EADDRINUSE: port 3000" }],
      unattributedFailures: [],
      otherLines: 1,
    });
  });

  it("keeps an unidentified failure visible instead of crediting it to somebody", () => {
    const attribution = attributeBackendLog(
      logLine({ event: "startup_failed", level: "error", message: "EADDRINUSE: port 3000" }),
    );
    expect(attribution.failed).toEqual([]);
    expect(attribution.unattributedFailures).toEqual(["EADDRINUSE: port 3000"]);
  });

  it("ignores records that are not server lifecycle entries", () => {
    const attribution = attributeBackendLog(
      [
        logLine({ scope: "http", event: "started", port: 3000, instanceId: "x" }),
        logLine({ scope: "server", event: "started", port: 3000 }),
        '{"half": ',
      ].join("\n"),
    );
    expect(attribution.booted).toEqual([]);
    expect(attribution.otherLines).toBe(3);
  });

  it("reads only an instance id from the in-page answer", () => {
    const identity = { instanceId: "  instance-a  " };
    expect(instanceIdFromProbe({ status: 200, body: JSON.stringify(identity) })).toBe("instance-a");
    expect(instanceIdFromProbe({ status: 404, body: JSON.stringify(identity) })).toBeNull();
    expect(instanceIdFromProbe({ status: 200, body: "{}" })).toBeNull();
    expect(instanceIdFromProbe({ status: 200, body: "<html>not this app</html>" })).toBeNull();
  });

  it("reads the port an origin names, including a default", () => {
    expect(portOfOrigin("http://localhost:3000")).toBe(3000);
    expect(portOfOrigin("http://localhost")).toBe(80);
    expect(portOfOrigin("https://localhost")).toBe(443);
    expect(portOfOrigin("not an origin")).toBeNull();
    expect(portOfOrigin(null)).toBeNull();
  });
});

describe("the observation is wired into CI, narrowly", () => {
  const WORKFLOW = fs.readFileSync(repoPath(".github", "workflows", "tests.yml"), "utf8");
  const lines = WORKFLOW.split(/\r?\n/);

  function stepBlock(name: string): string | null {
    const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
    if (start === -1) return null;
    const block = [lines[start]];
    for (let index = start + 1; index < lines.length; index++) {
      if (/^ {6}- name: /.test(lines[index])) break;
      block.push(lines[index]);
    }
    return block.join("\n");
  }

  it("runs both observations and never lets one hide the other", () => {
    const packaged = stepBlock("Observe the packaged WebView origin (G1)");
    const dev = stepBlock("Observe the development WebView origin (G2)");
    expect(packaged).toContain("bun run verify:packaged-origin");
    expect(packaged).toContain("--native-driver=");
    expect(dev).toContain("bun run observe:dev-origin");
    expect(dev).toContain("if: always()");
  });

  it("probes tauri-driver with the flag it implements, never a version flag", () => {
    const install = stepBlock("Install tauri-driver");
    if (install === null) throw new Error("the tauri-driver install step is missing");
    // tauri-driver exits 1 on an unknown argument, so a --version probe fails
    // the step before the driver is ever used. --help prints its banner, exit 0.
    expect(install).toContain("$driver --help");
    expect(install).toContain("$LASTEXITCODE");
    expect(install).not.toContain("--version");
  });

  it("provisions a driver that matches the installed WebView2 runtime", () => {
    const install = stepBlock("Install tauri-driver");
    expect(install).toContain("cargo install tauri-driver --locked");

    const driver = stepBlock("Install msedgedriver matching the WebView2 runtime");
    // The version comes from the runtime, and the download is derived from it.
    expect(driver).toContain("EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    expect(driver).toContain("https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip");
    // A mismatched pair fails every session, so the major version is verified.
    expect(driver).toContain("($version -split '\\.')[0]");
  });

  it("decides the final leg completed from its comparison, not its exit code", () => {
    const gate = stepBlock("Fail when the final leg did not complete");
    if (gate === null) throw new Error("the final-leg gate is missing");
    // Playwright exits non-zero for the known failing tests on BOTH revisions,
    // so the leg's own outcome cannot distinguish "ran" from "crashed".
    expect(gate).not.toContain("steps.final_leg.outcome");
    expect(gate).toContain("comparison.json");
    expect(gate).toContain("report.ok !== true");
  });

  it("uploads exactly the five named files and never the data directory", () => {
    const upload = stepBlock("Upload WebView origin evidence");
    if (upload === null) throw new Error("the origin-evidence upload step is missing");
    expect(upload).toContain("if: always()");

    const entries = upload
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("/origin-evidence/"));
    // Compared by suffix, so the assertion is about WHICH files are published,
    // not about where the runner's temp directory happens to be.
    const suffixMarker = "/origin-evidence/";
    const suffixes = entries.map((entry) =>
      entry.slice(entry.indexOf(suffixMarker) + suffixMarker.length),
    );
    expect(suffixes).toEqual([
      "packaged/packaged.json",
      "packaged/tauri-driver.log",
      "packaged/tbai.log",
      "dev/dev.json",
      "dev/tbai.log",
    ]);
    for (const entry of entries) {
      const base = entry.slice(entry.lastIndexOf("/") + 1);
      expect(base.includes(".")).toBe(true);
    }
  });
});

describe("the driver probe", () => {
  const SOURCE = fs.readFileSync(repoPath("scripts", "verify-packaged-webview-origin.ts"), "utf8");

  it("never asks the driver for a version, which tauri-driver does not implement", () => {
    expect(SOURCE).not.toContain('["--version"]');
  });

  it("treats a binary that runs as available and invents no version", () => {
    const checked = checkDriverBinary(process.execPath);
    expect(checked.available).toBe(true);
    expect(checked.version).toBeNull();
    expect(checked.helpLine?.trim().length ?? 0).toBeGreaterThan(0);
    expect(checked.error).toBeNull();
  });

  it("reports a missing binary as unavailable, with the reason", () => {
    const checked = checkDriverBinary(path.join(os.tmpdir(), "tbai-no-such-driver.exe"));
    expect(checked.available).toBe(false);
    expect(checked.version).toBeNull();
    expect(checked.error).not.toBeNull();
  });
});

describe("the host integrity the observation depends on", () => {
  // Sample lines as `whoami /groups` prints them; the label column is padded.
  const GROUP_LINES = [
    "GROUP INFORMATION",
    "-----------------",
    "Mandatory Label\\Medium Mandatory Level                        Label  S-1-16-8192",
  ].join("\r\n");

  it("reads each mandatory level whoami can report", () => {
    expect(parseIntegrityLevel(GROUP_LINES)).toBe("medium");
    for (const level of ["Low", "High", "System"]) {
      const text = `Mandatory Label\\${level} Mandatory Level    Label  S-1-16-0`;
      expect(parseIntegrityLevel(text)).toBe(level.toLowerCase() as "low" | "high" | "system");
    }
  });

  it("says unknown rather than guessing when no label is present", () => {
    expect(parseIntegrityLevel("")).toBe("unknown");
    expect(parseIntegrityLevel("GROUP INFORMATION\r\n-----------------")).toBe("unknown");
    // An unrecognised level is not coerced into a known one.
    expect(parseIntegrityLevel("Mandatory Label\\Untrusted Mandatory Level")).toBe("unknown");
  });
});

describe("G1 runs where WebView2 honours the driver's debugging port", () => {
  const WORKFLOW = fs.readFileSync(repoPath(".github", "workflows", "tests.yml"), "utf8");
  const SOURCE = fs.readFileSync(repoPath("scripts", "verify-packaged-webview-origin.ts"), "utf8");

  function g1Step(): string {
    const lines = WORKFLOW.split(/\r?\n/);
    const start = lines.findIndex(
      (line) => line.trim() === "- name: Observe the packaged WebView origin (G1)",
    );
    if (start === -1) throw new Error("the G1 step is missing");
    const block: string[] = [];
    for (let index = start + 1; index < lines.length; index++) {
      if (/^ {6}- name: /.test(lines[index])) break;
      block.push(lines[index]);
    }
    return block.join("\n");
  }

  it("de-elevates the packaged observation before driving it", () => {
    const step = g1Step();
    // WebView2 Runtime 150+ drops WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS in an
    // elevated host, and that variable carries the port msedgedriver attaches to.
    expect(step).toContain("--integrity Medium");
    expect(step).toContain('icacls "$env:GITHUB_WORKSPACE"');
    // The observation itself must be the de-elevated command, not a sibling.
    expect(step.indexOf("--integrity Medium")).toBeLessThan(step.indexOf("verify:packaged-origin"));
    // An absolute app path, so the child does not depend on its working directory.
    expect(step).toContain("(Resolve-Path");
    // The de-elevated child must still be able to resolve the runner.
    expect(step).toContain("Get-Command bun");
  });

  it("takes gsudo from the pinned archive, not from an installer that edits PATH", () => {
    // The MSI writes to %ProgramFiles% and appends to the machine PATH, which the
    // already-running step cannot observe; run 40292211888 failed exactly there.
    const step = g1Step();
    expect(step).not.toContain("winget");
    expect(step).toContain("gerardog/gsudo/releases/download/v2.6.1/gsudo.portable.zip");
    // A pinned hash, checked before anything from the archive is executed.
    expect(step).toContain("21130bf178d7b9891207f00bff56f05b6b363ce9cec7b2d084e45fb12ee51f44");
    expect(step.indexOf("Get-FileHash")).toBeLessThan(step.indexOf("--integrity Medium"));
    expect(step).toContain('"x64\\gsudo.exe"');
  });

  it("records the integrity level, and names it when a session times out on an elevated host", () => {
    expect(SOURCE).toContain("readHostIntegrity()");
    expect(SOURCE).toContain("integrity: hostIntegrity.level");
    expect(SOURCE).toContain('elevated && assessment.stage === "session-create"');
  });
});

describe("G2 launch configuration: the debug-port overlay", () => {
  function windowAt(overlay: Record<string, unknown>, index: number): Record<string, unknown> {
    const app = overlay.app;
    if (app === null || typeof app !== "object") throw new Error("the overlay has no app section");
    const windows = (app as Record<string, unknown>).windows;
    if (!Array.isArray(windows)) throw new Error("the overlay has no window list");
    const entry: unknown = windows[index];
    if (entry === null || typeof entry !== "object") throw new Error("the window entry is missing");
    return entry as Record<string, unknown>;
  }

  const config = {
    build: { devUrl: "http://localhost:3000" },
    app: {
      windows: [
        { label: "main", title: "TBAi", width: 1280, decorations: false },
        { label: "second" },
      ],
    },
  };

  it("adds the arguments to every window and preserves what was there", () => {
    const built = buildDebugPortOverlay(config, "--remote-debugging-port=5555");
    expect(built.error).toBeNull();
    if (built.overlay === null) throw new Error("no overlay was built");

    const main = windowAt(built.overlay, 0);
    expect(main.label).toBe("main");
    expect(main.width).toBe(1280);
    expect(main.decorations).toBe(false);
    expect(main.additionalBrowserArgs).toBe("--remote-debugging-port=5555");
    expect(windowAt(built.overlay, 1).additionalBrowserArgs).toBe("--remote-debugging-port=5555");
  });

  it("refuses a configuration it cannot attach a port to, instead of writing a partial one", () => {
    for (const malformed of [null, {}, { app: {} }, { app: { windows: [] } }]) {
      const built = buildDebugPortOverlay(malformed, "--remote-debugging-port=5555");
      expect(built.overlay).toBeNull();
      expect(built.error).toContain("app.windows");
    }
  });
});

describe("G2 launch attribution", () => {
  it("keeps the opening of the log and says how much it dropped", () => {
    const text = `${"a".repeat(20)}${"b".repeat(80)}`;
    const head = headText(text, 20);
    expect(head.startsWith("a".repeat(20))).toBe(true);
    expect(head).toContain("80 characters omitted");
    expect(headText("short", 20)).toBe("short");
  });

  it("picks the lines that say whether the build finished and the app started", () => {
    const log = [
      "   Compiling tbai v0.1.0",
      "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.4s",
      "     Running `target\\debug\\tbai.exe`",
      "GET /readyz 200",
      "error[E0433]: failed to resolve: use of undeclared crate",
    ].join("\n");

    expect(selectLaunchMarkers(log, 10)).toEqual([
      "Compiling tbai v0.1.0",
      "Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.4s",
      "Running `target\\debug\\tbai.exe`",
      "error[E0433]: failed to resolve: use of undeclared crate",
    ]);
    expect(selectLaunchMarkers(log, 1)).toEqual(["Compiling tbai v0.1.0"]);
    expect(selectLaunchMarkers("GET /readyz 200\nGET /api/server 200", 10)).toEqual([]);
  });
});

describe("the packaged origin cannot drift from the documented one", () => {
  it("matches the origin docs/architecture.md records for Windows WebView2", () => {
    const architecture = fs.readFileSync(repoPath("docs", "architecture.md"), "utf8");
    const documented = /Windows WebView2 produces the origin `(https?:\/\/[^`]+)`/.exec(
      architecture,
    );
    expect(documented?.[1]).toBe(EXPECTED_PACKAGED_ORIGIN);
  });
});
