import { Hono } from "hono";
import { quickMessageService } from "../services/quick-messages";
import {
  quickMessageCreateSchema,
  quickMessageUpdateSchema,
  quickMessageReorderSchema,
} from "../lib/validation";
import { storageError } from "./shared";

const app = new Hono();

// User-saved quick messages (reusable composer snippets)
app.get("/api/quick-messages", async (c) => {
  try {
    return c.json(await quickMessageService.list());
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/quick-messages", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = quickMessageCreateSchema.parse(body);
    const message = await quickMessageService.create({
      title: parsed.title ?? undefined,
      content: parsed.content ?? undefined,
    });
    return c.json(message);
  } catch (e) {
    return storageError(c, e);
  }
});

app.patch("/api/quick-messages/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = quickMessageUpdateSchema.parse(body);
    const message = await quickMessageService.update(id, {
      title: parsed.title ?? undefined,
      content: parsed.content ?? undefined,
    });
    if (!message) return c.json({ error: "Quick message not found" }, 404);
    return c.json(message);
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/api/quick-messages/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const removed = await quickMessageService.remove(id);
    if (!removed) return c.json({ error: "Quick message not found" }, 404);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/quick-messages/reorder", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = quickMessageReorderSchema.parse(body);
    await quickMessageService.reorder(parsed.ids);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

export default app;
