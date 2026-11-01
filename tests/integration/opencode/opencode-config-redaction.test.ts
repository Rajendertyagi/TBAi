import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";

/**
 * Unit B — the configuration route returns a REDACTED, read-only projection.
 *
 * Three guarantees are proved here:
 *
 * 1. **Nothing secret leaves the server.** The response carries no
 *    credential at any depth, including inside the native-JSON text.
 * 2. **The document is not writable in either mode.** The managed child
 *    inherits TBAi's environment, so the file it reports is the user's own
 *    OpenCode document, outside any TBAi-owned root (§9.3(1)); the projection
 *    says so (`editable: false`, `writeDisabledReason`) instead of letting the
 *    page offer a save that must fail.
 * 3. **A refused write leaves the file byte-identical**, credentials included:
 *    the refusal happens before the document is read.
 */

const SECRET = "sk-do-not-leak-me";
const CONFIG_DIRECTORY = process.env.DATA_DIR ?? "";
const CONFIG_PATH = join(CONFIG_DIRECTORY, "opencode-redaction-fixture.json");

const CONFIG_TEXT = `${JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    shell: "powershell",
    model: "anthropic/claude-sonnet-4-5",
    providers: {
      openrouter: {
        name: "OpenRouter",
        settings: { apiKey: SECRET, baseURL: "https://openrouter.ai/api/v1" },
        headers: { Authorization: `Bearer ${SECRET}` },
      },
    },
    mcp: {
      servers: {
        github: {
          type: "remote",
          url: "https://mcp.example",
          headers: { Authorization: `Bearer ${SECRET}` },
          oauth: { client_id: "public-id", client_secret: SECRET },
        },
      },
    },
    permissions: [{ action: "question", resource: "*", effect: "ask" }],
    // A substitution reference OUTSIDE every schema-derived secret location:
    // the documented string form, and the object form.
    instructions: ["{file:~/.secrets/openai-key}"],
    agents: {
      build: { description: "use {env:ACME_API_KEY}", system: { file: "/run/secrets/acme.pem" } },
    },
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
        {
          type: "document",
          path: CONFIG_PATH,
          info: JSON.parse(CONFIG_TEXT) as unknown,
        },
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

beforeAll(async () => {
  await Bun.write(CONFIG_PATH, CONFIG_TEXT);
});

afterAll(() => {
  fixtureServer.stop(true);
  (openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
    originalEnsureBaseUrl;
});

describe("GET /api/opencode/config", () => {
  it("returns no credential at any depth, including inside the native text", async () => {
    const response = await openCodeApp.request("http://localhost/config");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string;
      raw: string;
      malformed: boolean;
      permissions: unknown;
    };

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET);
    expect(body.raw).not.toContain(SECRET);
    // The redaction marker is present, so the values were masked rather than
    // dropped.
    expect(body.raw).toContain("[redacted]");
    // The structure survives: this is a projection, not a stripped document.
    expect(body.raw).toContain("openrouter");
    expect(body.raw).toContain("opencode.ai/config.json");
  });

  it("reports the document as read-only with the managed refusal reason", async () => {
    const response = await openCodeApp.request("http://localhost/config");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string;
      editable: boolean;
      writeDisabledReason: string | null;
    };
    // The fixture runs with an unresolved target, which is treated as managed.
    expect(body.editable).toBe(false);
    expect(body.writeDisabledReason).toBe("managed_root_not_owned");
    // The projection still names the document it read; refusing the write does
    // not refuse the read.
    expect(body.path).toBe(CONFIG_PATH);
  });

  it("still reports the permission rules the page edits", async () => {
    const response = await openCodeApp.request("http://localhost/config");
    const body = (await response.json()) as { permissions: unknown };
    expect(body.permissions).toEqual([{ action: "question", resource: "*", effect: "ask" }]);
  });

  it("masks a substitution reference outside every secret location", async () => {
    // The reference shape is self-identifying, so it is masked wherever it
    // occurs — including outside the schema's secret locations, and in the
    // documented string form.
    const response = await openCodeApp.request("http://localhost/config");
    const body = (await response.json()) as { raw: string };

    expect(body.raw).not.toContain("openai-key");
    expect(body.raw).not.toContain("ACME_API_KEY");
    expect(body.raw).not.toContain("/run/secrets/acme.pem");
    expect(body.raw).toContain("[redacted]");
    // The structure survives: the reference is masked, not dropped.
    expect(body.raw).toContain("instructions");
  });
});

describe("the permission write path is refused", () => {
  it("answers 409 and leaves the real file byte-identical, credentials included", async () => {
    const before = await Bun.file(CONFIG_PATH).text();

    const response = await openCodeApp.request("http://localhost/config/permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "question", resource: "*", effect: "allow" }),
    });
    expect(response.status).toBe(409);

    // Nothing was written: the document is the user's own and there is no
    // TBAi-owned root to contain a write (§9.3(1)), so the redaction path is
    // never re-serialised to disk. The credential survives because the file is
    // untouched, not because a write preserved it.
    const after = await Bun.file(CONFIG_PATH).text();
    expect(after).toBe(before);
    const parsed = JSON.parse(after) as {
      providers: Record<string, { settings: { apiKey: string } }>;
      mcp: { servers: Record<string, { oauth: { client_secret: string } }> };
      permissions: Array<{ action: string; effect: string }>;
    };
    expect(parsed.providers.openrouter?.settings.apiKey).toBe(SECRET);
    expect(parsed.mcp.servers.github?.oauth.client_secret).toBe(SECRET);
  });
});
