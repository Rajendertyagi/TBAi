import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";
import { stripComments } from "../../helpers/web/source-scope";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  installManagedTarget,
  resetConnectionStateForTests,
} from "@/services/opencode/connectionState.ts";

const MANAGED_PASSWORD = "redirect-managed-password";
const MANAGED_AUTHORIZATION = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${MANAGED_PASSWORD}`,
).toString("base64")}`;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

interface Fixture {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  readonly stop: () => void;
}

const fixtures: Fixture[] = [];

function startFixture(handler: (request: Request) => Response | Promise<Response>): Fixture {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      });
      return handler(request);
    },
  });
  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
  fixtures.push(fixture);
  return fixture;
}

function redirectTo(target: string, status = 302): Response {
  return new Response(null, { status, headers: { location: `${target}/steal` } });
}

const { default: openCodeApp } = await import("@/routes/opencode.ts");

beforeEach(() => {
  resetConnectionStateForTests();
});

afterEach(() => {
  resetConnectionStateForTests();
  for (const fixture of fixtures.splice(0)) fixture.stop();
});

describe("managed proxy redirect refusal", () => {
  it("returns a typed 502 and never forwards the redirect", async () => {
    const redirectTarget = startFixture(() => Response.json({ stolen: true }));
    const managed = startFixture(() => redirectTo(redirectTarget.baseUrl));
    installManagedTarget({ baseUrl: managed.baseUrl, password: MANAGED_PASSWORD });

    const response = await openCodeApp.request("http://localhost/api/opencode/info", {
      headers: { Authorization: "Bearer browser-controlled-secret" },
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("OpenCode refused a redirect");

    expect(managed.requests).toHaveLength(1);
    expect(managed.requests[0]?.url).toBe(`${managed.baseUrl}/api/info`);
    expect(managed.requests[0]?.authorization).toBe(MANAGED_AUTHORIZATION);
    expect(redirectTarget.requests).toHaveLength(0);
  });

  it("uses the shared transport and owns no redirect policy", () => {
    const source = stripComments(
      readFileSync(path.join(REPO_ROOT, "src/routes/opencode.ts"), "utf8"),
    );
    expect(source).not.toMatch(/\bredirect\s*:/);
    expect(source).not.toContain("globalThis.fetch");
    expect(source).not.toContain("fetch(");
    expect(source).toContain("target.transport(");
    expect(source).toContain("resolveOpenCodeRuntimeTarget");
  });
});
