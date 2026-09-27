import { defineConfig } from "@playwright/test";

/**
 * E2E suite configuration.
 *
 * The suite runs against ITS OWN server and its OWN database by default. That is
 * the whole reason `scripts/start-e2e-server.ts` exists: the suite used to have
 * no `webServer`, so every run attached to whatever server was already up —
 * normally the maintainer's live app — and both polluted real conversations and
 * let specs corrupt each other through a shared database.
 *
 * The port is fixed (not read from `data/port`, which the live server rewrites on
 * every boot) and the data/workspace dirs are private, so a run neither reads nor
 * writes anything the maintainer cares about.
 *
 * To point the suite at a server you manage yourself — a live instance with real
 * providers, for the acceptance specs that need one — set `TBAI_E2E_BASE_URL`.
 * The managed server is then skipped entirely and nothing is reset.
 */
const E2E_PORT = process.env.TBAI_E2E_PORT ?? "3101";
const E2E_URL = `http://localhost:${E2E_PORT}`;

/** Set by the maintainer to opt out of the managed server entirely. */
const externalBaseUrl = process.env.TBAI_E2E_BASE_URL;

/**
 * Set by `scripts/run-e2e.ts`, which starts (and resets) the server itself
 * between spec files. Without this the config's own `webServer` would race the
 * runner's server for the same port.
 */
const serverAlreadyManaged = process.env.TBAI_E2E_EXTERNAL_SERVER === "1";

/**
 * Specs that need a REAL model, and therefore real credentials.
 *
 * These are acceptance tests, not hermetic tests: their own docblocks say
 * "nothing mocked" and "verified in this environment to answer real requests".
 * The isolated server deliberately has no provider credentials, so running them
 * by default only produces failures that say nothing about the code.
 *
 * Run them explicitly, against a server you trust:
 *   TBAI_E2E_LIVE=1 TBAI_E2E_BASE_URL=http://localhost:3001 bunx playwright test
 */
const liveSpecs = "**/*-live.spec.ts";
const runLive = process.env.TBAI_E2E_LIVE === "1";

function resolveBaseUrl(): string {
  // An explicit override wins: that is the "point me at my own server" escape hatch.
  if (externalBaseUrl) return externalBaseUrl;
  // Otherwise the suite talks to the server Playwright starts, on the fixed E2E
  // port. It must NOT read data/port here: that file belongs to whichever server
  // the maintainer happens to be running, and following it silently points the
  // whole suite back at the live app — which is exactly the isolation this
  // config exists to provide.
  return E2E_URL;
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "line",
  // Live acceptance specs are opt-in; see `liveSpecs` above.
  testIgnore: runLive ? [] : [liveSpecs],
  use: {
    baseURL: resolveBaseUrl(),
  },
  ...(externalBaseUrl || serverAlreadyManaged
    ? {}
    : {
        webServer: {
          command: "bun run ../scripts/start-e2e-server.ts",
          url: `${E2E_URL}/readyz`,
          // Never adopt an already-running server: adopting one is precisely how
          // this suite ended up writing to the maintainer's database.
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
        },
      }),
  projects: [
    // Headed msedge is the default (matches how the app is developed on the
    // desktop); the headless chromium project keeps the suite runnable
    // unattended / in CI where no display exists.
    {
      name: "edge-headed",
      use: { channel: "msedge", headless: false },
    },
    {
      name: "chromium-headless",
      use: { channel: "chromium", headless: true },
    },
  ],
});
