/**
 * TEMPORARY POC-ONLY Vite config — Dockview lab evaluation.
 * Not part of production. Adds an /api proxy to the running backend so the
 * dev-only lab route can use real conversations. Delete after the POC.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { generateThemes } from "./scripts/generate-themes";

function themesPlugin() {
  return {
    name: "tbai-themes-poc",
    buildStart() {
      generateThemes();
    },
  };
}

export default defineConfig({
  plugins: [themesPlugin(), react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3015",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
