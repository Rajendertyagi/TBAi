import { describe, expect, it, afterAll } from "bun:test";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import foldersApp from "@/routes/folders.ts";

const app = new Hono();
app.route("/api/folders", foldersApp);

describe("PATCH /api/folders/reorder", () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-reorder-test-"));
  const dir1 = path.join(tempBase, "f1");
  const dir2 = path.join(tempBase, "f2");
  fs.mkdirSync(dir1);
  fs.mkdirSync(dir2);

  afterAll(() => {
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  });

  it("persists folder order and re-indexes correctly", async () => {
    const res1 = await app.request("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Folder 1", path: dir1 }),
    });
    const f1 = (await res1.json()) as { id: string };

    const res2 = await app.request("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Folder 2", path: dir2 }),
    });
    const f2 = (await res2.json()) as { id: string };

    expect(f1.id).toBeDefined();
    expect(f2.id).toBeDefined();

    const res = await app.request("/api/folders/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [f2.id, f1.id] }),
    });

    expect(res.status).toBe(200);

    const listRes = await app.request("/api/folders");
    const list = (await listRes.json()) as Array<{ id: string }>;
    const ids = list.map((f) => f.id);
    expect(ids.indexOf(f2.id)).toBeLessThan(ids.indexOf(f1.id));
  });
});
