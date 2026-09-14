/**
 * Unit tests for the quick-message service (sole SQL owner).
 *
 * DB isolation: tests/setup.ts redirects DATA_DIR to tmp.
 */
import { describe, it, expect } from "bun:test";
import { quickMessageService } from "../../src/services/quick-messages";

describe("quickMessageService", () => {
  it("creates with empty title/content and appends sort order", async () => {
    const a = await quickMessageService.create({ title: "", content: "" });
    const b = await quickMessageService.create({ title: "Second", content: "b" });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    expect((await quickMessageService.list()).map((m) => m.id)).toEqual([a.id, b.id]);
    await quickMessageService.remove(a.id);
    await quickMessageService.remove(b.id);
  });

  it("updates title/content and bumps updated_at", async () => {
    const created = await quickMessageService.create({ title: "t", content: "c" });
    const updated = await quickMessageService.update(created.id, {
      title: "t2",
      content: "c2",
    });
    expect(updated?.title).toBe("t2");
    expect(updated?.content).toBe("c2");
    expect((updated?.updatedAt.getTime() ?? 0) >= created.updatedAt.getTime()).toBe(true);
    await quickMessageService.remove(created.id);
  });

  it("partial update leaves other fields untouched", async () => {
    const created = await quickMessageService.create({ title: "keep", content: "c" });
    const updated = await quickMessageService.update(created.id, { content: "c2" });
    expect(updated?.title).toBe("keep");
    expect(updated?.content).toBe("c2");
    await quickMessageService.remove(created.id);
  });

  it("remove returns false for unknown ids", async () => {
    await expect(quickMessageService.remove("nope")).resolves.toBe(false);
    await expect(quickMessageService.update("nope", { title: "x" })).resolves.toBeNull();
  });

  it("reorder persists manual ordering and ignores unknown ids", async () => {
    const a = await quickMessageService.create({ title: "a", content: "" });
    const b = await quickMessageService.create({ title: "b", content: "" });
    const c = await quickMessageService.create({ title: "c", content: "" });
    await quickMessageService.reorder([c.id, a.id, "ghost", b.id]);
    expect((await quickMessageService.list()).map((m) => m.id)).toEqual([c.id, a.id, b.id]);
    await quickMessageService.reorder([]);
    for (const m of [a, b, c]) await quickMessageService.remove(m.id);
  });

  it("list returns empty when nothing is stored", async () => {
    for (const m of await quickMessageService.list()) {
      await quickMessageService.remove(m.id);
    }
    await expect(quickMessageService.list()).resolves.toEqual([]);
  });
});
