import { Hono, type Context } from "hono";
import { z } from "zod";
import { newRequestId } from "../lib/logger";
import { sanitizeStreamError } from "../lib/redact";
import { runRead, runWrite, runEdit, runBash, runList, runSearch, runStat, runDelete, runProcesses, runKill, runSysinfo, ToolError, WORKSPACE_DIR, inspectTarget } from "../services/tools";
import { mintGrant } from "../services/grants";
import { resolveConversationWorkspace, WorkspaceError } from "../services/workspace";
import { toolReadSchema, toolWriteSchema, toolEditSchema, toolBashSchema, toolListSchema, toolSearchSchema, toolStatSchema, toolDeleteSchema, toolKillSchema, outsideCheckSchema, outsideGrantSchema, outsideRunGrantedSchema } from "../lib/validation";

const app = new Hono<{ Variables: { requestId: string } }>();

// ---- Agentic tool execution endpoints (sandboxed to WORKSPACE_DIR) ----
// Manual/test surface for the server-executed native tools (the model-facing
// path runs through the chat route's streamText tool loop instead).
function toolHandler<T>(schema: z.ZodType<T>, fn: (args: T) => unknown | Promise<unknown>) {
  return async (c: Context) => {
    const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
    try {
      const body = await c.req.json().catch(() => ({}));
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid tool arguments", issues: parsed.error.issues, requestId }, 400);
      }
      const out = await fn(parsed.data);
      return c.json(out);
    } catch (e) {
      if (e instanceof ToolError)
        return c.json({ error: e.message, requestId }, 400);
      return c.json(
        { error: sanitizeStreamError(e), requestId },
        500,
      );
    }
  };
}

app.post("/api/tools/read", toolHandler(toolReadSchema, (args) => runRead(args, WORKSPACE_DIR)));
app.post("/api/tools/write", toolHandler(toolWriteSchema, (args) => runWrite(args, WORKSPACE_DIR)));
app.post("/api/tools/edit", toolHandler(toolEditSchema, (args) => runEdit(args, WORKSPACE_DIR)));
app.post("/api/tools/bash", toolHandler(toolBashSchema, (args) => runBash(args, WORKSPACE_DIR)));
app.post("/api/tools/list", toolHandler(toolListSchema, (args) => runList(args, WORKSPACE_DIR)));
app.post("/api/tools/search", toolHandler(toolSearchSchema, (args) => runSearch(args, WORKSPACE_DIR)));
app.post("/api/tools/stat", toolHandler(toolStatSchema, (args) => runStat(args, WORKSPACE_DIR)));
app.post("/api/tools/delete", toolHandler(toolDeleteSchema, (args) => runDelete(args, WORKSPACE_DIR)));
app.post("/api/tools/processes", toolHandler(z.object({}), () => runProcesses()));
app.post("/api/tools/kill", toolHandler(toolKillSchema, (args) => runKill(args)));
app.post("/api/tools/sysinfo", toolHandler(z.object({}), () => runSysinfo()));

// ---- One-shot outside-workspace authorization (chat approval flow) ----
// ---- One-shot outside-workspace authorization (chat approval flow) ----
// /check is pure (inside? + canonical target, no side effects); /grant mints
// a single-use authorization consumed at execution. The server resolves
// everything itself — the client only names conversation, tool, and path.
app.post("/api/tools/check", async (c) => {
  const parsed = outsideCheckSchema.safeParse(await c.req.json().catch(() => ({})));
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues, requestId }, 400);
  }
  const { conversationId, path: target } = parsed.data;
  let dir: string;
  try {
    dir = (await resolveConversationWorkspace(conversationId)).dir;
  } catch (err) {
    if (err instanceof WorkspaceError) {
      return c.json({ error: `Workspace error: ${err.message}`, code: err.code, requestId }, 400);
    }
    throw err;
  }
  const { real, root, inside } = inspectTarget(target, dir);
  return c.json({ inside, resolvedTarget: real, root, requestId });
});

app.post("/api/tools/grant", async (c) => {
  const parsed = outsideGrantSchema.safeParse(await c.req.json().catch(() => ({})));
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues, requestId }, 400);
  }
  const { conversationId, tool, path: target } = parsed.data;
  let dir: string;
  try {
    dir = (await resolveConversationWorkspace(conversationId)).dir;
  } catch (err) {
    if (err instanceof WorkspaceError) {
      return c.json({ error: `Workspace error: ${err.message}`, code: err.code, requestId }, 400);
    }
    throw err;
  }
  const { real, root, inside } = inspectTarget(target, dir);
  if (inside) {
    return c.json({ error: "Target is inside the workspace; no grant needed", requestId }, 400);
  }
  const grant = mintGrant({ conversationId, tool, resolvedTarget: real });
  return c.json({
    ok: true,
    grantId: grant.id,
    resolvedTarget: real,
    root,
    expiresAt: grant.expiresAt,
    requestId,
  });
});

// One-shot granted execution for UNGATED read tools (read_file, list_dir,
// search_files, file_info): the Failed card's "Approve once" lands here with
// the original args. The server re-validates (per-tool schema), requires the
// target to be outside (inside targets use the normal path), mints a grant,
// and executes inline exactly once — the grant is consumed inside resolveSafe
// and revoked if execution throws, so nothing persists to authorize a later
// call. Destructive tools and run_command keep the gate flow and are refused
// here. The frontend attaches the returned output to the SAME tool call via
// addResult, so the run continues without a resend.
const grantedReadRunners: Record<string, (args: unknown, ws: string, scope: { conversationId: string; tool: string }) => unknown> = {
  read_file: (args, ws, scope) => {
    const parsed = toolReadSchema.safeParse(args);
    if (!parsed.success) throw new ToolError("Invalid read_file arguments");
    return runRead(parsed.data, ws, scope);
  },
  list_dir: (args, ws, scope) => {
    const parsed = toolListSchema.safeParse(args);
    if (!parsed.success) throw new ToolError("Invalid list_dir arguments");
    return runList(parsed.data, ws, scope);
  },
  search_files: (args, ws, scope) => {
    const parsed = toolSearchSchema.safeParse(args);
    if (!parsed.success) throw new ToolError("Invalid search_files arguments");
    return runSearch(parsed.data, ws, scope);
  },
  file_info: (args, ws, scope) => {
    const parsed = toolStatSchema.safeParse(args);
    if (!parsed.success) throw new ToolError("Invalid file_info arguments");
    return runStat(parsed.data, ws, scope);
  },
};

app.post("/api/tools/run-granted", async (c) => {
  const parsed = outsideRunGrantedSchema.safeParse(await c.req.json().catch(() => ({})));
  const requestId = (c.get("requestId") as string | undefined) ?? newRequestId();
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues, requestId }, 400);
  }
  const { conversationId, tool, args } = parsed.data;
  let dir: string;
  try {
    dir = (await resolveConversationWorkspace(conversationId)).dir;
  } catch (err) {
    if (err instanceof WorkspaceError) {
      return c.json({ error: `Workspace error: ${err.message}`, code: err.code, requestId }, 400);
    }
    throw err;
  }
  const runner = grantedReadRunners[tool];
  if (!runner) return c.json({ error: "Tool keeps the gate flow", requestId }, 400);
  const rawPath =
    args && typeof args === "object" && "path" in (args as Record<string, unknown>)
      ? String((args as Record<string, unknown>).path ?? ".")
      : ".";
  const { real, inside } = inspectTarget(rawPath, dir);
  if (inside) {
    return c.json({ error: "Target is inside the workspace; no grant needed", requestId }, 400);
  }
  // Mint-then-consume atomically around one synchronous execution: the grant
  // below is spent inside resolveSafe (or revoked on throw), so no live
  // authorization survives this request either way.
  const grant = mintGrant({ conversationId, tool, resolvedTarget: real });
  try {
    const output = runner(args, dir, { conversationId, tool });
    return c.json({ ok: true, grantId: grant.id, resolvedTarget: real, output, requestId });
  } catch (e) {
    grant.consumed = true;
    if (e instanceof ToolError) return c.json({ error: e.message, requestId }, 400);
    return c.json({ error: e instanceof Error ? e.message : "Tool failed", requestId }, 500);
  }
});

export default app;
