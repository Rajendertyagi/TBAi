import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { db } from "@/db";
import preferencesRoutes from "@/routes/preferences";
import { WORKSPACE_PREFERENCES_SNAPSHOT_KEY } from "@/services/preferences";
import { conversationService, messageService } from "@/services/storage";

const app = new Hono();
app.route("/api/preferences", preferencesRoutes);

function clearSnapshot(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [WORKSPACE_PREFERENCES_SNAPSHOT_KEY]);
}

function writeRawSnapshot(value: unknown): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [WORKSPACE_PREFERENCES_SNAPSHOT_KEY, JSON.stringify(value), Date.now()],
  );
}

afterEach(() => {
  clearSnapshot();
});

describe("preferences routes (canonical)", () => {
  it("GET returns authoritative snapshot with defaults", async () => {
    const res = await app.request("http://localhost/api/preferences");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revision: number;
      sharedTabs: unknown[];
      preferences: unknown;
    };
    expect(body.revision).toBe(0);
    expect(body.sharedTabs).toEqual([]);
    expect(body.preferences).toBeTruthy();
    expect((body as any).sharedActiveConversationId).toBeUndefined();
    expect((body as any).migration).toBeUndefined();
  });

  it("GET returns explicit error for corrupt snapshot and preserves row", async () => {
    writeRawSnapshot({ revision: 1, sharedTabs: "nope", preferences: {} });
    const res = await app.request("http://localhost/api/preferences");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("WORKSPACE_PREFERENCES_CORRUPT");
    const row = db
      .query("SELECT value FROM app_settings WHERE key = ?")
      .get(WORKSPACE_PREFERENCES_SNAPSHOT_KEY) as { value: string } | undefined;
    expect(row?.value).toContain('"sharedTabs":"nope"');
  });

  it("PATCH applies allowlisted preferences with leaf-field merge and CAS", async () => {
    const res = await app.request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, preferences: { appearance: { themeMode: "dark" } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revision: number;
      preferences: { appearance: { themeMode: string; lightTheme: string } };
    };
    expect(body.revision).toBe(1);
    expect(body.preferences.appearance.themeMode).toBe("dark");
    expect(body.preferences.appearance.lightTheme).toBe("default");
  });

  it("PATCH returns 409 with authoritative state on stale revision and no mutation", async () => {
    await app.request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, preferences: { appearance: { themeMode: "dark" } } }),
    });

    const stale = await app.request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 0,
        preferences: { appearance: { themeMode: "light" } },
      }),
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      conflict: boolean;
      revision: number;
      snapshot: { preferences: { appearance: { themeMode: string } } };
    };
    expect(body.conflict).toBe(true);
    expect(body.revision).toBe(1);
    expect(body.snapshot.preferences.appearance.themeMode).toBe("dark");
  });

  it("PATCH rejects unknown preference groups", async () => {
    const res = await app.request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, preferences: { nope: true } }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH requires baseRevision", async () => {
    const res = await app.request("http://localhost/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: { appearance: { themeMode: "dark" } } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("preferences routes (shared tab intents)", () => {
  it("POST /tabs/open validates conversation, requires kind, and is idempotent", async () => {
    const conv = await conversationService.create({
      title: "Test",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    try {
      const first = await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, conversationId: conv.id, kind: "chat" }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        revision: number;
        sharedTabs: Array<{ ref: string; kind: string }>;
      };
      expect(firstBody.revision).toBe(1);
      expect(firstBody.sharedTabs[0]).toEqual({ ref: conv.id, kind: "chat" });

      const second = await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, conversationId: conv.id, kind: "chat" }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { revision: number; sharedTabs: unknown[] };
      expect(secondBody.revision).toBe(1);
      expect(secondBody.sharedTabs).toHaveLength(1);
    } finally {
      await conversationService.delete(conv.id).catch(() => {});
    }
  });

  it("POST /tabs/open rejects kind mismatch with conversation engine", async () => {
    const conv = await conversationService.create({
      title: "Test",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    try {
      const res = await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, conversationId: conv.id, kind: "agent" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await conversationService.delete(conv.id).catch(() => {});
    }
  });

  it("POST /tabs/open returns 404 for missing conversation", async () => {
    const res = await app.request("http://localhost/api/preferences/tabs/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, conversationId: "missing-conv", kind: "chat" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /tabs/close returns 409 on stale revision with authoritative state and no mutation", async () => {
    const conv = await conversationService.create({
      title: "Test",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    try {
      await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, conversationId: conv.id, kind: "chat" }),
      });
      const stale = await app.request("http://localhost/api/preferences/tabs/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, conversationId: conv.id }),
      });
      expect(stale.status).toBe(409);
      const body = (await stale.json()) as {
        conflict: boolean;
        snapshot: { sharedTabs: unknown[] };
      };
      expect(body.conflict).toBe(true);
      expect(body.snapshot.sharedTabs).toHaveLength(1);
    } finally {
      await conversationService.delete(conv.id).catch(() => {});
    }
  });

  it("POST /tabs/close-batch requires anchor for others/right", async () => {
    const res = await app.request("http://localhost/api/preferences/tabs/close-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, mode: "others" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /tabs/close and /tabs/close-batch remove membership but never delete conversation data", async () => {
    const conv = await conversationService.create({
      title: "Keep via route",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    await messageService.upsertStored(conv.id, {
      id: "msg-route-keep",
      parent_id: null,
      format: "aui/v1",
      content: { role: "user", parts: [{ type: "text", text: "persist" }] },
    });
    try {
      await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, conversationId: conv.id, kind: "chat" }),
      });
      const closed = await app.request("http://localhost/api/preferences/tabs/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, conversationId: conv.id }),
      });
      expect(closed.status).toBe(200);
      const closedBody = (await closed.json()) as { sharedTabs: unknown[] };
      expect(closedBody.sharedTabs).toEqual([]);

      expect(await conversationService.get(conv.id)).not.toBeNull();
      expect((await messageService.listThreadMessages(conv.id)).length).toBe(1);

      await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 2, conversationId: conv.id, kind: "chat" }),
      });
      const batch = await app.request("http://localhost/api/preferences/tabs/close-batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 3, mode: "all" }),
      });
      expect(batch.status).toBe(200);
      expect(await conversationService.get(conv.id)).not.toBeNull();
      expect((await messageService.listThreadMessages(conv.id)).length).toBe(1);
    } finally {
      await conversationService.delete(conv.id).catch(() => {});
    }
  });

  it("POST /tabs/reorder moves tab by intent", async () => {
    const a = await conversationService.create({
      title: "A",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    const b = await conversationService.create({
      title: "B",
      engine: "direct",
      providerId: "test",
      workspaceMode: "simple",
    } as any);
    try {
      await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, conversationId: a.id, kind: "chat" }),
      });
      await app.request("http://localhost/api/preferences/tabs/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, conversationId: b.id, kind: "chat" }),
      });
      const res = await app.request("http://localhost/api/preferences/tabs/reorder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 2, conversationId: b.id, toIndex: 0 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sharedTabs: Array<{ ref: string }> };
      expect(body.sharedTabs.map((t) => t.ref)).toEqual([b.id, a.id]);
    } finally {
      await conversationService.delete(a.id).catch(() => {});
      await conversationService.delete(b.id).catch(() => {});
    }
  });
});
