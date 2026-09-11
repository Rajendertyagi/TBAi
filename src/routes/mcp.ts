import { Hono } from "hono";
import { z } from "zod";
import { mcpManager } from "../services/mcp/manager";
import { redact } from "../lib/redact";
import { logger, normalizeError } from "../lib/logger";
import {
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
  mcpServerTestSchema,
  mcpResourceReadSchema,
  mcpPromptGetSchema,
  mcpElicitResolveSchema,
} from "../lib/validation";

const app = new Hono<{ Variables: { requestId: string } }>();

// List all configured servers with live connection status + discovered capabilities.
app.get("/servers", (c) => {
  return c.json(mcpManager.getStatuses());
});

// Create a new MCP server configuration.
app.post("/servers", async (c) => {
  const parsed = mcpServerCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid MCP server config", issues: parsed.error.issues }, 400);
  }
  const created = mcpManager.createConfig(parsed.data);
  // Auto-connect if enabled.
  if (created.enabled) {
    void mcpManager.connect(created.id);
  }
  return c.json(created, 201);
});

// Update an existing MCP server configuration.
app.put("/servers/:id", async (c) => {
  const parsed = mcpServerUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid MCP server config", issues: parsed.error.issues }, 400);
  }
  const updated = mcpManager.updateConfig(c.req.param("id"), parsed.data);
  if (!updated) return c.json({ error: "MCP server not found" }, 404);
  return c.json(updated);
});

// Delete an MCP server configuration.
app.delete("/servers/:id", async (c) => {
  mcpManager.deleteConfig(c.req.param("id"));
  return c.json({ success: true });
});

// Enable/disable a server.
app.post("/servers/:id/enable", async (c) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "enabled boolean required" }, 400);
  mcpManager.setEnabled(c.req.param("id"), parsed.data.enabled);
  return c.json({ success: true });
});

// Explicit connect.
app.post("/servers/:id/connect", async (c) => {
  await mcpManager.connect(c.req.param("id"));
  return c.json({ success: true });
});

// Explicit disconnect.
app.post("/servers/:id/disconnect", async (c) => {
  await mcpManager.disconnect(c.req.param("id"));
  return c.json({ success: true });
});

// Explicitly push roots/list_changed to a connected server (official SDK
// notification; no-op when disconnected).
app.post("/servers/:id/roots/notify", async (c) => {
  const ok = await mcpManager.notifyRootsChanged(c.req.param("id"));
  return c.json({ success: true, notified: ok });
});

// Re-discover capabilities for a connected server.
app.post("/servers/:id/refresh", async (c) => {
  await mcpManager.refresh(c.req.param("id"));
  return c.json({ success: true });
});

// Test a connection configuration without persisting it.
app.post("/servers/test", async (c) => {
  const parsed = mcpServerTestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid MCP server config", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await mcpManager.testConnection(parsed.data);
    return c.json(result);
  } catch (e) {
    logger.warn("mcp", "test_connection_failed", {
      requestId: (c.get("requestId") as string | undefined),
      transport: parsed.data.transport,
      ...normalizeError(e),
    });
    return c.json({ ok: false, error: redact(e), toolCount: 0, resourceCount: 0, promptCount: 0, tools: [], resources: [], prompts: [], transport: parsed.data.transport });
  }
});

// Read a resource from a connected server (used by "Insert into chat").
app.post("/servers/:id/resource/read", async (c) => {
  const parsed = mcpResourceReadSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "uri required" }, 400);
  try {
    const result = await mcpManager.readResource(c.req.param("id"), parsed.data.uri);
    return c.json(result);
  } catch (e) {
    logger.warn("mcp", "resource_read_failed", {
      requestId: (c.get("requestId") as string | undefined),
      ...normalizeError(e),
    });
    return c.json({ error: redact(e) }, 400);
  }
});

// Retrieve a prompt from a connected server (used by "Insert into chat").
app.post("/servers/:id/prompt/get", async (c) => {
  const parsed = mcpPromptGetSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "name required" }, 400);
  try {
    const result = await mcpManager.getPrompt(c.req.param("id"), parsed.data.name, parsed.data.arguments ?? undefined);
    return c.json(result);
  } catch (e) {
    logger.warn("mcp", "prompt_request_failed", {
      requestId: (c.get("requestId") as string | undefined),
      ...normalizeError(e),
    });
    return c.json({ error: redact(e) }, 400);
  }
});

// Return the first pending server-initiated elicitation, if any (polled by the UI).
app.get("/elicit/pending", (c) => {
  return c.json(mcpManager.getPendingElicitation() ?? null);
});

// Resolve (answer) a pending elicitation from the UI.
app.post("/elicit/resolve", async (c) => {
  const parsed = mcpElicitResolveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid elicitation resolution", issues: parsed.error.issues }, 400);
  const ok = mcpManager.resolveElicitation(
    parsed.data.serverId,
    parsed.data.elicitationId,
    parsed.data.action,
    parsed.data.content ?? undefined,
  );
  if (!ok) return c.json({ error: "No matching pending elicitation" }, 404);
  return c.json({ success: true });
});

export default app;
