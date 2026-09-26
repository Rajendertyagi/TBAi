import { describe, expect, it } from "bun:test";
import { OPENCODE_CONFIG } from "../../config/opencode";

const fixturePassword = "opencode-client-test-password";
const clientModuleUrl = new URL("./client.ts", import.meta.url).href;
const fixtureServerInfo = {
  version: "2.0.15",
  pid: 1,
  urls: [],
  paths: { tmp: "opencode-client-fixture" },
} as const;
const backendAuthorization = `Basic ${Buffer.from(
  `${OPENCODE_CONFIG.authUsername}:${fixturePassword}`,
).toString("base64")}`;

type CapturedRequest = {
  readonly authorization: string | null;
  readonly directory: string | null;
  readonly method: string;
  readonly url: string;
};

/** Starts a deterministic V2 HTTP fixture and records the official client's request. */
function startClientFixture(): {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  readonly stop: () => void;
} {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests.push({
        authorization: request.headers.get("authorization"),
        directory: request.headers.get("x-opencode-directory"),
        method: request.method,
        url: request.url,
      });
      return Response.json(fixtureServerInfo);
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/** Calls the real client in a fresh Bun process so unrelated module mocks cannot replace it. */
async function runIsolatedClient(
  baseUrl: string,
  directory?: string | null,
): Promise<void> {
  const options = directory === undefined ? "{}" : `{ directory: ${JSON.stringify(directory)} }`;
  const script = `
    const { createOpenCodeClient } = await import(${JSON.stringify(clientModuleUrl)});
    const client = createOpenCodeClient(${JSON.stringify(baseUrl)}, ${options});
    await client.server.info();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [OPENCODE_CONFIG.authPasswordEnvVar]: fixturePassword,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`OpenCode client fixture process failed: ${stderr}`);
  }
}

describe("createOpenCodeClient server.info transport headers", () => {
  it("sends backend Basic auth and an encoded directory header", async () => {
    const fixture = startClientFixture();
    const directory = "/workspace/project one";

    try {
      await runIsolatedClient(fixture.baseUrl, directory);

      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toEqual({
        authorization: backendAuthorization,
        directory: encodeURIComponent(directory),
        method: "GET",
        url: `${fixture.baseUrl}/api/info`,
      });
    } finally {
      fixture.stop();
    }
  });

  it("keeps auth while omitting the directory header when no directory is supplied", async () => {
    const fixture = startClientFixture();

    try {
      await runIsolatedClient(fixture.baseUrl, null);

      expect(fixture.requests[0]?.authorization).toBe(backendAuthorization);
      expect(fixture.requests[0]?.directory).toBeNull();
    } finally {
      fixture.stop();
    }
  });
});
