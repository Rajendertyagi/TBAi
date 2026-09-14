import { Hono, type Context } from "hono";
import { z } from "zod";
import { newRequestId } from "../lib/logger";
import { runRead, runWrite, runEdit, runBash, runList, runSearch, runStat, runDelete, runProcesses, runKill, runSysinfo, ToolError } from "../services/tools";
import { toolReadSchema, toolWriteSchema, toolEditSchema, toolBashSchema, toolListSchema, toolSearchSchema, toolStatSchema, toolDeleteSchema, toolKillSchema } from "../lib/validation";

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
        { error: e instanceof Error ? e.message : "Tool failed", requestId },
        500,
      );
    }
  };
}

app.post("/api/tools/read", toolHandler(toolReadSchema, runRead));
app.post("/api/tools/write", toolHandler(toolWriteSchema, runWrite));
app.post("/api/tools/edit", toolHandler(toolEditSchema, runEdit));
app.post("/api/tools/bash", toolHandler(toolBashSchema, runBash));
app.post("/api/tools/list", toolHandler(toolListSchema, runList));
app.post("/api/tools/search", toolHandler(toolSearchSchema, runSearch));
app.post("/api/tools/stat", toolHandler(toolStatSchema, runStat));
app.post("/api/tools/delete", toolHandler(toolDeleteSchema, runDelete));
app.post("/api/tools/processes", toolHandler(z.object({}), () => runProcesses()));
app.post("/api/tools/kill", toolHandler(toolKillSchema, runKill));
app.post("/api/tools/sysinfo", toolHandler(z.object({}), () => runSysinfo()));

export default app;
