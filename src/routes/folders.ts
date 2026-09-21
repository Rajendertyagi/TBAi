import { Hono } from "hono";
import fs from "fs";
import path from "path";
import {
  folderService,
  folderLinkService,
  folderGroupService,
  FolderRegistrationError,
} from "../services/folders";
import { logger } from "../lib/logger";
import {
  folderCreateSchema,
  folderUpdateSchema,
  folderLinkCreateSchema,
  folderLinkUpdateSchema,
  folderGroupCreateSchema,
  folderGroupUpdateSchema,
  folderBrowseSchema,
} from "../lib/validation";
import { storageError } from "./shared";

/**
 * Folder / workspace registry API (codeg-aligned two-mode model).
 *
 * Registered project folders, their linked/allowed paths (authorization records
 * — no real symlinks in phase 1), and folder groups. A dedicated `/browse`
 * endpoint lets the UI pick an arbitrary local directory for registration
 * (distinct from the workspace-confined `/api/tools/list`).
 */
const app = new Hono();

app.get("/", async (c) => {
  try {
    // User-facing list: excludes hidden chat folders.
    return c.json(await folderService.listOpen());
  } catch (e) {
    return storageError(c, e);
  }
});

app.get("/all", async (c) => {
  try {
    // Full list including hidden chat folders (for by-id lookups).
    return c.json(await folderService.listAll());
  } catch (e) {
    return storageError(c, e);
  }
});

app.get("/open", async (c) => {
  try {
    return c.json(await folderService.listOpen());
  } catch (e) {
    return storageError(c, e);
  }
});

app.get("/groups", async (c) => {
  try {
    return c.json(await folderGroupService.list());
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/groups", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = folderGroupCreateSchema.parse(body);
    return c.json(await folderGroupService.create(parsed));
  } catch (e) {
    return storageError(c, e);
  }
});

app.patch("/groups/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = folderGroupUpdateSchema.parse(body);
    const group = await folderGroupService.update(id, parsed);
    if (!group) return c.json({ error: "Group not found" }, 404);
    return c.json(group);
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/groups/:id", async (c) => {
  try {
    await folderGroupService.delete(c.req.param("id"));
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/groups/:id/set", async (c) => {
  try {
    const groupId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const folderId = typeof body.folderId === "string" ? body.folderId.trim() : "";
    if (!folderId) {
      return c.json({ error: "folderId is required" }, 400);
    }
    await folderGroupService.setFolderGroup(folderId, groupId);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.get("/browse", async (c) => {
  try {
    const url = new URL(c.req.url);
    const requested = url.searchParams.get("path");
    const base = requested && requested.trim() ? requested.trim() : process.cwd();
    const abs = path.resolve(base);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return c.json({ error: "Directory not found", path: abs }, 404);
    }
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(abs);
    return c.json({
      path: abs,
      parent: parent === abs ? null : parent,
      entries,
    });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = folderCreateSchema.parse(body);
    const folder = await folderService.openFolder(parsed);
    // Registration lifecycle record (stable id only — never the path; the
    // folder id is the canonical identity every consumer binds by).
    logger.info("workspace", "workspace.register", { folderId: folder.id });
    return c.json(folder);
  } catch (e) {
    if (e instanceof FolderRegistrationError) {
      logger.warn("workspace", "workspace.rejected", {
        reason: e.code,
        message: e.message,
      });
      const status = e.code === "path_missing" ? 404 : 400;
      return c.json({ error: e.message }, status);
    }
    return storageError(c, e);
  }
});

app.get("/:id", async (c) => {
  try {
    const folder = await folderService.get(c.req.param("id"));
    if (!folder) return c.json({ error: "Folder not found" }, 404);
    return c.json(folder);
  } catch (e) {
    return storageError(c, e);
  }
});

app.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = folderUpdateSchema.parse(body);
    const folder = await folderService.update(id, parsed);
    if (!folder) return c.json({ error: "Folder not found" }, 404);
    return c.json(folder);
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/:id/close", async (c) => {
  try {
    await folderService.close(c.req.param("id"));
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/:id/open", async (c) => {
  try {
    await folderService.open(c.req.param("id"));
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

/** Remove from workspace = close (row stays, conversations stay bound). */
app.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    await folderService.close(id);
    // Close, not delete: the row and its conversation bindings survive, so
    // bound Project conversations keep resolving instead of being orphaned.
    logger.info("workspace", "workspace.unregister", { folderId: id });
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

// ---- Folder links (authorization records) ----

app.get("/:id/links", async (c) => {
  try {
    return c.json(await folderLinkService.listByFolder(c.req.param("id")));
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/:id/links/preview", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({ targets: [] }));
    const targets = Array.isArray(body.targets) ? body.targets : [];
    const plan = await folderLinkService.preview(
      c.req.param("id"),
      targets.map((t: { name?: string; targetPath?: string }) => ({
        name: String(t.name ?? ""),
        targetPath: String(t.targetPath ?? ""),
      })),
    );
    return c.json({ plan });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/:id/links", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = folderLinkCreateSchema.parse(body);
    const link = await folderLinkService.insert(
      c.req.param("id"),
      parsed.name,
      parsed.targetPath,
    );
    return c.json(link);
  } catch (e) {
    return storageError(c, e);
  }
});

app.patch("/:id/links/:linkId", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = folderLinkUpdateSchema.parse(body);
    const link = await folderLinkService.rename(c.req.param("linkId"), parsed.name);
    if (!link) return c.json({ error: "Link not found" }, 404);
    return c.json(link);
  } catch (e) {
    return storageError(c, e);
  }
});

app.delete("/:id/links/:linkId", async (c) => {
  try {
    await folderLinkService.delete(c.req.param("linkId"));
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

export default app;
