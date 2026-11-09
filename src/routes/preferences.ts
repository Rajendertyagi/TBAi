import { Hono } from "hono";
import { z } from "zod";
import {
  sharedTabCloseBatchBodySchema,
  sharedTabCloseBodySchema,
  sharedTabOpenBodySchema,
  sharedTabReorderBodySchema,
  workspacePreferencesPatchBodySchema,
} from "../lib/validation";
import { workspacePreferencesService, WorkspacePreferencesCorruptError } from "../services/preferences";
import { conversationService } from "../services/storage";
import { disableIdleTimeout } from "./shared";

const app = new Hono();

function conflictResponse(result: { revision: number; snapshot: unknown }) {
  return {
    error: "Workspace preferences revision conflict",
    conflict: true as const,
    revision: result.revision,
    snapshot: result.snapshot,
  };
}

function corruptResponse(err: WorkspacePreferencesCorruptError) {
  return {
    error: err.message,
    code: err.code,
  };
}

app.get("/", (c) => {
  try {
    return c.json(workspacePreferencesService.get());
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) {
      return c.json(corruptResponse(err), 500);
    }
    throw err;
  }
});

app.get("/stream", (c) => {
  const encoder = new TextEncoder();
  let lastSentRevision = -1;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      disableIdleTimeout(c);
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const onChange = (event: {
        revision: number;
        changedKeys?: string[];
        originWindowId?: string;
        ts: number;
      }) => {
        if (event.revision <= lastSentRevision) return;
        lastSentRevision = event.revision;
        send("preferences.changed", {
          revision: event.revision,
          originWindowId: event.originWindowId,
          ts: event.ts,
        });
      };
      const unsubscribe = workspacePreferencesService.subscribe(onChange);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 5000);
      const abort = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      c.req.raw.signal.addEventListener("abort", abort);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

app.patch("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = workspacePreferencesPatchBodySchema.safeParse(body);
  if (!parsed.success) {
    const hasBaseRevision =
      typeof body === "object" &&
      body !== null &&
      "baseRevision" in body &&
      typeof (body as { baseRevision?: unknown }).baseRevision === "number";
    const hasPreferences = typeof body === "object" && body !== null && "preferences" in body;
    if (!hasBaseRevision) return c.json({ error: "baseRevision is required" }, 400);
    if (!hasPreferences) return c.json({ error: "preferences is required" }, 400);
    return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
  }

  try {
    const result = workspacePreferencesService.patch({
      baseRevision: parsed.data.baseRevision,
      preferences: parsed.data.preferences,
      originWindowId: parsed.data.originWindowId,
    });
    if (result.conflict) return c.json(conflictResponse(result), 409);
    return c.json(result.snapshot);
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) {
      return c.json(corruptResponse(err), 500);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: "Invalid preferences patch", issues: err.issues }, 400);
    }
    if (err instanceof Error && /Unknown preferences group|preferences must be an object|invalid/i.test(err.message)) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

app.post("/tabs/open", async (c) => {
  const parsed = sharedTabOpenBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
  }
  const conversation = await conversationService.get(parsed.data.conversationId);
  if (!conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }
  // Validate kind matches conversation engine (defense in depth); server is authoritative.
  const expectedKind = conversation.engine === "opencode" ? "agent" : "chat";
  if (parsed.data.kind !== expectedKind) {
    return c.json({ error: "Tab kind does not match conversation engine" }, 400);
  }
  try {
    const result = workspacePreferencesService.openTab({
      baseRevision: parsed.data.baseRevision,
      kind: parsed.data.kind,
      conversationId: parsed.data.conversationId,
      originWindowId: parsed.data.originWindowId,
    });
    if (result.conflict) return c.json(conflictResponse(result), 409);
    return c.json(result.snapshot);
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) return c.json(corruptResponse(err), 500);
    throw err;
  }
});

app.post("/tabs/close", async (c) => {
  const parsed = sharedTabCloseBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
  }
  try {
    const result = workspacePreferencesService.closeTab({
      baseRevision: parsed.data.baseRevision,
      conversationId: parsed.data.conversationId,
      originWindowId: parsed.data.originWindowId,
    });
    if (result.conflict) return c.json(conflictResponse(result), 409);
    return c.json(result.snapshot);
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) return c.json(corruptResponse(err), 500);
    throw err;
  }
});

app.post("/tabs/close-batch", async (c) => {
  const parsed = sharedTabCloseBatchBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
  }
  try {
    const result = workspacePreferencesService.closeTabsBatch({
      baseRevision: parsed.data.baseRevision,
      mode: parsed.data.mode,
      anchorConversationId: parsed.data.anchorConversationId,
      originWindowId: parsed.data.originWindowId,
    });
    if (result.conflict) return c.json(conflictResponse(result), 409);
    return c.json(result.snapshot);
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) return c.json(corruptResponse(err), 500);
    throw err;
  }
});

app.post("/tabs/reorder", async (c) => {
  const parsed = sharedTabReorderBodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", issues: parsed.error.issues }, 400);
  }
  try {
    const result = workspacePreferencesService.reorderTab({
      baseRevision: parsed.data.baseRevision,
      conversationId: parsed.data.conversationId,
      toIndex: parsed.data.toIndex,
      originWindowId: parsed.data.originWindowId,
    });
    if (result.conflict) return c.json(conflictResponse(result), 409);
    return c.json(result.snapshot);
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) return c.json(corruptResponse(err), 500);
    throw err;
  }
});

export default app;
