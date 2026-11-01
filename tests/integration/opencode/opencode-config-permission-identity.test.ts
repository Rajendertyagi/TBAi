import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * The permission write route is refused before it reads or writes.
 *
 * This file used to pin the route's position-plus-identity semantics — a
 * configuration can carry the same `(action, resource)` pair twice, and only
 * the file position tells them apart. Those semantics now live in
 * `tests/unit/opencode/configDocument.test.ts`, where `setOpenCodePermissionEffectAt`
 * and its siblings are exercised directly.
 *
 * At the HTTP boundary there is nothing left to address: the managed service
 * has no TBAi-owned configuration root (§9.3(1)), so the route refuses every
 * write before resolving a target. What is worth proving here is that the
 * refusal is total — no read, no write, no fixture request — because a route
 * that partially ran before refusing is exactly how a stale base or a leaked
 * credential would reach disk or the wire.
 */

const CONFIG_DIRECTORY = process.env.DATA_DIR ?? "";
const CONFIG_PATH = join(CONFIG_DIRECTORY, "opencode-permission-identity-fixture.json");

const CONFIG_TEXT = `${JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    permissions: [
      { action: "question", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "ask" },
    ],
  },
  null,
  2,
)}\n`;

let fixtureRequests = 0;

const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    fixtureRequests += 1;
    const url = new URL(request.url);
    if (url.pathname === "/api/config") {
      return Response.json([
        { type: "document", path: CONFIG_PATH, info: JSON.parse(CONFIG_TEXT) as unknown },
      ]);
    }
    return Response.json({ fixture: "opencode-config" });
  },
});

const fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.port}`;
const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => fixtureBaseUrl;

const { default: openCodeApp } = await import("@/routes/opencode.ts");

/** The rules currently on disk. */
async function rulesOnDisk(): Promise<Array<{ action: string; resource: string; effect: string }>> {
  const parsed = JSON.parse(await Bun.file(CONFIG_PATH).text()) as {
    permissions: Array<{ action: string; resource: string; effect: string }>;
  };
  return parsed.permissions;
}

async function write(
  method: "POST" | "DELETE" | "PUT",
  body: Record<string, unknown>,
): Promise<Response> {
  return openCodeApp.request("http://localhost/config/permissions", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await Bun.write(CONFIG_PATH, CONFIG_TEXT);
  fixtureRequests = 0;
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("every permission write is refused before the document is read", () => {
  it("refuses a positional edit and leaves the file byte-identical", async () => {
    const response = await write("PUT", {
      index: 1,
      action: "question",
      resource: "*",
      effect: "allow",
    });

    expect(response.status).toBe(409);
    expect(fixtureRequests).toBe(0);
    expect(await rulesOnDisk()).toEqual([
      { action: "question", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "ask" },
    ]);
  });

  it("refuses an identity-only edit, an add and a removal", async () => {
    const edited = await write("PUT", { action: "question", resource: "*", effect: "allow" });
    const added = await write("POST", { action: "shell", resource: "*", effect: "deny" });
    const removed = await write("DELETE", {
      index: 0,
      action: "question",
      resource: "*",
      effect: "ask",
    });

    expect(edited.status).toBe(409);
    expect(added.status).toBe(409);
    expect(removed.status).toBe(409);
    // Not even the read that precedes a transform reached the service.
    expect(fixtureRequests).toBe(0);
    expect((await rulesOnDisk())[0]?.effect).toBe("ask");
  });
});
