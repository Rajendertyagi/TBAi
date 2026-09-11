import { Hono } from "hono";
import { memoryService } from "../services/storage";
import { storageError } from "./shared";

const app = new Hono();

// Memory routes
app.get("/api/memories", async (c) => {
  try {
    const memories = await memoryService.list();
    return c.json(memories);
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/memories", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const memory = await memoryService.add(body.content || "");
    return c.json(memory);
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/api/memories/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await memoryService.delete(id);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

export default app;
