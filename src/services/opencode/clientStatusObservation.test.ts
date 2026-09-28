/**
 * Status observation for session lookups.
 *
 * The stale-pointer fix rests on one fact being recoverable: OpenCode answers a
 * lookup for a session that does not exist with a bare `404` and an EMPTY body,
 * and the official client throws that status away with the unparseable body.
 *
 * These cases therefore drive the REAL official client — real transport, real
 * `UnsupportedContentType` throw — against a loopback fixture that answers with
 * the real response shapes. They run the client in a fresh Bun process, following
 * `client.test.ts`, because several existing suites replace `./client` with
 * `mock.module` without restoring it and bun's module registry is process-global;
 * in-process, the "real" client would silently be a neighbour's stub.
 *
 * Attribution is the part that could quietly go wrong. One client is shared
 * across a lookup, a create and a model assignment, so a status reported for one
 * session must never be handed back for another — and only a positive 404 may
 * ever authorise replacing a session.
 */

import { describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "../../config/opencode";

const fixturePassword = "opencode-status-test-password";
const clientModuleUrl = new URL("./client.ts", import.meta.url).href;

const MISSING = "ses_definitely_not_here";
const PRESENT = "ses_present";
const UNPARSEABLE = "ses_unparseable";
const NEVER_QUERIED = "ses_never_queried";

/** What the isolated client reports for a set of session ids. */
interface Probe {
  /** `"ok"` when the lookup returned a session, `"threw"` when it did not. */
  readonly results: Record<string, "ok" | "threw">;
  /** The status the seam would read back for each id, or null for none. */
  readonly statuses: Record<string, number | null>;
}

/** Starts a V2 fixture that answers with the real shapes for each case. */
function startFixture(): { readonly baseUrl: string; readonly stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      const id = path.replace("/api/session/", "");
      // A live session: JSON, as the server always answers a real lookup.
      if (id === PRESENT) {
        return Response.json({ data: { id, location: { directory: "/tmp" } } });
      }
      // Exists, but answers with a body the client cannot parse: the same class of
      // thrown error as the 404, and a different status. That difference is the
      // entire basis of the fix, so it has to be observable.
      if (id === UNPARSEABLE) {
        return new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      // A missing session: bare 404, empty body, no content type — the real shape.
      return new Response(null, { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Runs the real client in a fresh process and reports what the seam would see.
 *
 * `neverQueried` is deliberately NOT looked up, so its status must come back
 * null — the "no evidence" answer the seam treats as absence-unproven.
 */
async function probeInIsolation(baseUrl: string): Promise<Probe> {
  const script = `
    const { createOpenCodeClient, lastStatusForSessionLookup } =
      await import(${JSON.stringify(clientModuleUrl)});
    const ids = ${JSON.stringify([MISSING, PRESENT, UNPARSEABLE, NEVER_QUERIED])};
    const client = createOpenCodeClient(${JSON.stringify(baseUrl)});
    const results = {};
    for (const id of ids) {
      if (id === ${JSON.stringify(NEVER_QUERIED)}) continue;
      try {
        await client.session.get({ sessionID: id });
        results[id] = "ok";
      } catch {
        results[id] = "threw";
      }
    }
    const statuses = {};
    for (const id of ids) statuses[id] = lastStatusForSessionLookup(client, id);
    console.log(JSON.stringify({ results, statuses }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, [OPENCODE_CONFIG.authPasswordEnvVar]: fixturePassword },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`status-observation fixture process failed: ${stderr}`);
  }
  return JSON.parse(stdout.trim()) as Probe;
}

describe("the status the official client discards is recovered", () => {
  it("reports 404 for a session the server does not have", async () => {
    const fixture = startFixture();
    try {
      const probe = await probeInIsolation(fixture.baseUrl);
      // The real client cannot parse the empty body. That throw is the defect's
      // origin, so it being harmless here is the point.
      expect(probe.results[MISSING]).toBe("threw");
      expect(probe.statuses[MISSING]).toBe(404);
    } finally {
      fixture.stop();
    }
  });

  it("reports 200 for a session that does exist", async () => {
    const fixture = startFixture();
    try {
      const probe = await probeInIsolation(fixture.baseUrl);
      expect(probe.results[PRESENT]).toBe("ok");
      expect(probe.statuses[PRESENT]).toBe(200);
    } finally {
      fixture.stop();
    }
  });

  it("reports 200, not 404, for a body it cannot parse", async () => {
    // The safety case. Same thrown error as the missing session, different status.
    // Reading this as absent would replace a live session and lose its history.
    const fixture = startFixture();
    try {
      const probe = await probeInIsolation(fixture.baseUrl);
      expect(probe.results[UNPARSEABLE]).toBe("threw");
      expect(probe.statuses[UNPARSEABLE]).toBe(200);
    } finally {
      fixture.stop();
    }
  });

  it("reports null when no such lookup was ever made", async () => {
    const fixture = startFixture();
    try {
      const probe = await probeInIsolation(fixture.baseUrl);
      expect(probe.statuses[NEVER_QUERIED]).toBeNull();
    } finally {
      fixture.stop();
    }
  });
});

describe("a status is never attributed to the wrong session", () => {
  it("does not lend one session's 404 to another id", async () => {
    // Every id is looked up on the SAME client, so a shared "last status" would
    // report 404 for the live session too — and the seam would then replace it.
    const fixture = startFixture();
    try {
      const probe = await probeInIsolation(fixture.baseUrl);
      expect(probe.statuses[MISSING]).toBe(404);
      expect(probe.statuses[PRESENT]).toBe(200);
      expect(probe.statuses[UNPARSEABLE]).toBe(200);
    } finally {
      fixture.stop();
    }
  });
});
