import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [
    {
      name: "edge-headed",
      use: { channel: "msedge", headless: false },
    },
  ],
});
