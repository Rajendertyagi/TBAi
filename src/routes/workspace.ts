import { Hono } from "hono";
import path from "node:path";
import { getWorkspaceDir } from "../services/tools";

/**
 * Workspace metadata (read-only). The frontend's breadcrumb header shows the
 * workspace root name; this is the only endpoint that exposes it (tool
 * results carry workspace-relative paths, never the absolute root).
 */
const app = new Hono();

app.get("/api/workspace", (c) => {
  const dir = getWorkspaceDir();
  return c.json({ name: path.basename(dir) || dir, path: dir });
});

export default app;
