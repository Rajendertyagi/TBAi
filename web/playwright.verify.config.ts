import { defineConfig } from "@playwright/test";

// TEMPORARY verification config against isolated :3001. Deleted after the run.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://localhost:3001",
  },
  projects: [
    {
      name: "edge-headed",
      use: { channel: "msedge", headless: false },
    },
  ],
});
