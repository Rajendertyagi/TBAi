import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * Unit C (write path) — a permission rule is addressed by POSITION plus a
 * re-checked identity.
 *
 * A configuration can carry the same `(action, resource)` pair twice. OpenCode
 * resolves the array last-match-wins, so the LAST of them is the one in
 * force; editing the first would change a rule that never decides anything
 * while the page reported success.
 *
 * These tests pin the write path's behaviour for that case. The page's own
 * duplicate-row affordance is a separate decision (G7) and is not covered
 * here.
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

const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
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

async function putEffect(body: Record<string, unknown>): Promise<Response> {
  return openCodeApp.request("http://localhost/config/permissions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await Bun.write(CONFIG_PATH, CONFIG_TEXT);
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("PUT /api/opencode/config/permissions", () => {
  it("changes the rule at the position it was addressed by", async () => {
    const response = await putEffect({
      index: 1,
      action: "question",
      resource: "*",
      effect: "allow",
    });

    expect(response.status).toBe(200);
    const rules = await rulesOnDisk();
    // The SECOND of the two identical rules changed; the first did not.
    expect(rules[0]?.effect).toBe("ask");
    expect(rules[1]?.effect).toBe("allow");
    expect(rules[2]?.effect).toBe("ask");
  });

  it("refuses an ambiguous pair rather than applying it to an arbitrary match", async () => {
    const response = await putEffect({ action: "question", resource: "*", effect: "allow" });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("ambiguous");
    // Nothing was written.
    expect((await rulesOnDisk())[0]?.effect).toBe("ask");
    expect((await rulesOnDisk())[1]?.effect).toBe("deny");
  });

  it("refuses a position whose rule is not the one the caller read", async () => {
    const response = await putEffect({
      index: 2,
      action: "question",
      resource: "*",
      effect: "allow",
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("changed on disk");
    expect((await rulesOnDisk())[2]?.effect).toBe("ask");
  });

  it("still edits a unique pair addressed without a position", async () => {
    const response = await putEffect({ action: "shell", resource: "*", effect: "deny" });

    expect(response.status).toBe(200);
    const rules = await rulesOnDisk();
    expect(rules[2]?.effect).toBe("deny");
    expect(rules[0]?.effect).toBe("ask");
    expect(rules[1]?.effect).toBe("deny");
  });
});
