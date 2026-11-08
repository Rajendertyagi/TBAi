import fs from "node:fs";
import { describe, expect, it } from "bun:test";
import { _resetModelCatalogCache } from "@/services/modelCatalog";
import { discoverModels } from "@/services/modelDiscovery";

describe("discovery and chat execution isolation from models.dev", () => {
  it("discovery succeeds and returns provider models even when models.dev is down", async () => {
    _resetModelCatalogCache();

    // Mock fetch for models.dev to fail while provider succeeds
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("models.dev")) {
        throw new Error("Models.dev network timeout");
      }
      if (urlStr.includes("api.openai.com")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }],
          }),
          { status: 200 },
        );
      }
      return originalFetch(url, init);
    }) as any;

    try {
      const models = await discoverModels({
        type: "openai",
        apiKey: "sk-test",
      });

      // Discovered chat model returned without enrichment, embed filtered
      expect(models.length).toBe(1);
      expect(models[0].id).toBe("gpt-4o");
      expect(models[0].contextWindow).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("chat execution path does not import or invoke modelCatalog", async () => {
    // Assert statically that the direct chat execution files do not import modelCatalog
    const chatFiles = [
      "src/routes/chat/assemble-run.ts",
      "src/routes/chat/execute-direct-stream.ts",
      "src/context/assemble.ts",
    ];

    for (const file of chatFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect(content.includes("modelCatalog")).toBe(false);
      expect(content.includes("MODELS_DEV")).toBe(false);
    }
  });
});
