import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * LIB-IMPL-04: valid JSONC configuration is readable, redacted, and read-only.
 *
 * The GET projection must parse JSONC for inspection, extract permissions, and
 * return a safe normalized redacted preview without exposing secrets or the
 * original unredacted source. Existing write refusals remain unchanged.
 */

const SECRET = "sk-jsonc-secret";
const CONFIG_DIRECTORY = process.env.DATA_DIR ?? "";
const CONFIG_PATH = join(CONFIG_DIRECTORY, "opencode-jsonc-fixture.jsonc");

const CONFIG_TEXT = `{
  // keep this comment in the source file
  "$schema": "https://opencode.ai/config.json",
  "shell": "powershell",
  "providers": {
    "openrouter": {
      "settings": { "apiKey": "${SECRET}", "baseURL": "https://openrouter.ai/api/v1", },
      "headers": { "Authorization": "Bearer ${SECRET}" }
    }
  },
  "mcp": {
    "servers": {
      "github": {
        "type": "remote",
        "headers": { "Authorization": "{env:GITHUB_TOKEN}" },
        "oauth": { "client_id": "public-id", "client_secret": "${SECRET}" }
      }
    }
  },
  "permissions": [
    { "action": "question", "resource": "*", "effect": "ask" },
  ],
}
`;

const fixtureServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/config") {
      return Response.json([
        {
          type: "document",
          path: CONFIG_PATH,
          info: {
            permissions: [{ action: "question", resource: "*", effect: "ask" }],
          },
        },
      ]);
    }
    return Response.json({ fixture: "opencode-config-jsonc" });
  },
});

const fixtureBaseUrl = `http://127.0.0.1:${fixtureServer.port}`;
const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => fixtureBaseUrl;

const { default: openCodeApp } = await import("@/routes/opencode.ts");

beforeAll(async () => {
  await Bun.write(CONFIG_PATH, CONFIG_TEXT);
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("GET /api/opencode/config for valid JSONC", () => {
  it("returns a readable, redacted, read-only projection without leaking secrets", async () => {
    const response = await openCodeApp.request("http://localhost/config");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string;
      raw: string;
      malformed: boolean;
      editable: boolean;
      writeDisabledReason: string | null;
      permissions: unknown;
    };

    expect(body.path).toBe(CONFIG_PATH);
    expect(body.malformed).toBe(false);
    expect(body.editable).toBe(false);
    expect(body.writeDisabledReason).toBe("managed_root_not_owned");
    expect(body.permissions).toEqual([{ action: "question", resource: "*", effect: "ask" }]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("keep this comment in the source file");
    expect(body.raw).toContain("[redacted]");
    expect(body.raw).toContain('"shell": "powershell"');
    expect(body.raw).not.toContain("// keep this comment in the source file");

    // Source file remains unchanged.
    expect(await Bun.file(CONFIG_PATH).text()).toBe(CONFIG_TEXT);
  });

  it("keeps permission writes refused and leaves the JSONC source byte-identical", async () => {
    const before = await Bun.file(CONFIG_PATH).text();
    const response = await openCodeApp.request("http://localhost/config/permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "question", resource: "*", effect: "allow" }),
    });
    expect(response.status).toBe(409);
    expect(await Bun.file(CONFIG_PATH).text()).toBe(before);
  });
});
