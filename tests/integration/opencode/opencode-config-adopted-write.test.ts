import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  installAdoptedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";

/**
 * CT7 at the HTTP boundary — adopted AND managed permission documents are
 * refused by every write route, before the route resolves a target or touches
 * a file.
 *
 * The route is the only production caller of the G4 gate, so this is the test
 * that would fail if the gate were removed from it. The fixture server stands
 * in for a managed server and answers nothing useful: a refused request must
 * never reach it.
 *
 * The managed case is not a formality. The managed child inherits the user's
 * config environment, so the document it reports is the user's own file — the
 * writer has no TBAi-owned root to contain (§9.3(1)). Refusing only the adopted
 * path would leave that write live.
 */

let fixtureRequests = 0;

const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    fixtureRequests += 1;
    return Response.json({ fixture: "opencode-adopted-write" });
  },
});

const { default: openCodeApp } = await import("@/routes/opencode.ts");

afterEach(() => {
  resetConnectionStateForTests();
  fixtureRequests = 0;
});

afterAll(() => {
  fixtureServer.stop(true);
});

/** Installs an adopted target so the route sees an adopted runtime. */
function adopt(): void {
  installAdoptedTarget({
    origin: `http://127.0.0.1:${fixtureServer.port}`,
    password: "synthetic-adopted-password",
  });
}

async function request(
  method: "POST" | "DELETE" | "PUT",
  body: Record<string, unknown>,
): Promise<Response> {
  return openCodeApp.request("http://localhost/config/permissions", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("an adopted service's configuration is read-only", () => {
  it("refuses PUT with 409 and the typed message", async () => {
    adopt();
    const response = await request("PUT", { action: "shell", resource: "*", effect: "deny" });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("adopted service");
    expect(fixtureRequests).toBe(0);
  });

  it("refuses POST with 409", async () => {
    adopt();
    const response = await request("POST", { action: "shell", resource: "*", effect: "ask" });

    expect(response.status).toBe(409);
    expect(fixtureRequests).toBe(0);
  });

  it("refuses DELETE with 409", async () => {
    adopt();
    const response = await request("DELETE", {
      index: 0,
      action: "shell",
      resource: "*",
      effect: "ask",
    });

    expect(response.status).toBe(409);
    expect(fixtureRequests).toBe(0);
  });
});

describe("a managed service's configuration is read-only too", () => {
  it("refuses PUT with 409, naming the user's own document, and reaches no service", async () => {
    const response = await request("PUT", { action: "shell", resource: "*", effect: "deny" });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("user's own");
    expect(fixtureRequests).toBe(0);
  });

  it("refuses POST and DELETE as well", async () => {
    const added = await request("POST", {
      action: "shell",
      resource: "*",
      effect: "ask",
    });
    const removed = await request("DELETE", {
      index: 0,
      action: "shell",
      resource: "*",
      effect: "ask",
    });

    expect(added.status).toBe(409);
    expect(removed.status).toBe(409);
    expect(fixtureRequests).toBe(0);
  });
});
