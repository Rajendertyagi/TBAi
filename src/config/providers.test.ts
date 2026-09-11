import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ProviderRegistry } from "./providers";
import type { ProviderConfig } from "../types";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE provider_configs (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, " +
      "endpoint TEXT, model TEXT NOT NULL, models TEXT, thinking TEXT, " +
      "api_protocol TEXT, is_active INTEGER DEFAULT 0, " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  return db;
}

function seed(
  db: Database,
  rows: Array<Partial<ProviderConfig> & { id: string; type: ProviderConfig["type"]; model: string }>,
) {
  const now = Date.now();
  for (const r of rows) {
    db.run(
      "INSERT INTO provider_configs (id, name, type, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        r.id,
        r.name ?? r.id,
        r.type,
        r.endpoint ?? null,
        r.model,
        JSON.stringify(r.models ?? []),
        r.thinking ?? "off",
        r.apiProtocol ?? null,
        r.isActive ? 1 : 0,
        now,
        now,
      ],
    );
  }
}

describe("ProviderRegistry — apiProtocol mapping", () => {
  let db: Database;
  let registry: ProviderRegistry;

  beforeEach(() => {
    db = freshDb();
    registry = ProviderRegistry.getInstance();
  });

  it("maps an explicit api_protocol value through to the config", async () => {
    seed(db, [{ id: "p1", type: "custom", model: "m", endpoint: "https://x/v1", apiProtocol: "chat-completions" }]);
    await registry.loadFromDb(db);
    expect(registry.get("p1")?.apiProtocol).toBe("chat-completions");
  });

  it("treats a NULL api_protocol as undefined (default applied later at model build)", async () => {
    seed(db, [{ id: "p2", type: "custom", model: "m", endpoint: "https://x/v1", apiProtocol: undefined }]);
    await registry.loadFromDb(db);
    expect(registry.get("p2")?.apiProtocol).toBeUndefined();
  });

  it("maps 'responses' for a native OpenAI provider", async () => {
    seed(db, [{ id: "p3", type: "openai", model: "gpt-x", apiProtocol: "responses" }]);
    await registry.loadFromDb(db);
    expect(registry.get("p3")?.apiProtocol).toBe("responses");
  });

  it("list() exposes apiProtocol but never the api key", async () => {
    seed(db, [{ id: "p4", type: "ollama", model: "llama3", endpoint: "http://localhost:11434/v1", apiProtocol: "chat-completions" }]);
    await registry.loadFromDb(db);
    const listed = registry.list().find((p) => p.id === "p4");
    expect(listed?.apiProtocol).toBe("chat-completions");
    expect("apiKey" in listed!).toBe(false);
  });
});
