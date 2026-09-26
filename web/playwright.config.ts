import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The app's port drifts across restarts (3000/3003/3004 seen — the server
 * falls back to the next free port when the default is occupied), so a
 * hardcoded baseURL breaks whenever it lands elsewhere. Resolution:
 *   1. `TBAI_E2E_BASE_URL` — explicit pin (CI, a fixed test port).
 *   2. `data/port` — the Tauri mirror the app itself writes on every boot /
 *      rebind; read from the repo root (this config lives in `web/`).
 *   3. `http://localhost:3000` — the default the server binds when 3000 is
 *      free, used only when neither override nor mirror is available.
 *
 * To run against a drifted/occupied port explicitly:
 *   $env:TBAI_E2E_BASE_URL="http://localhost:3003"; bun run test:e2e
 */
function resolveBaseUrl(): string {
  if (process.env.TBAI_E2E_BASE_URL) return process.env.TBAI_E2E_BASE_URL;
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "data", "port"),
      "utf8",
    ).trim();
    const port = Number.parseInt(raw, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return `http://localhost:${port}`;
    }
  } catch {
    /* no mirror file — fall through to the default */
  }
  return "http://localhost:3000";
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: resolveBaseUrl(),
  },
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
