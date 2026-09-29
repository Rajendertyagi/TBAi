/**
 * Reading OpenCode's own unified diff off a tool part's metadata.
 *
 * ## Why this is its own module
 *
 * Two places need the same answer and they sit on opposite sides of the
 * dependency graph. The tool renderer walks the message's preserved V2 parts to
 * find a call by id; the V2 projection is *building* a part and already holds its
 * metadata. Putting the extraction in the renderer would make the projection
 * import `tools/opencode/adapt`, and `adapt` already imports the projection's
 * types — that is a cycle.
 *
 * So the primitive lives here, in lib, and both callers use it. One validator,
 * one answer, either direction of the graph.
 *
 * ## What the metadata actually looks like
 *
 * A completed or pending `edit` / `write` part carries
 * `state.metadata.files[].patch`, a standard unified diff. Verified against the
 * live server: `edit` produces a real `@@` hunk, and `write` produces
 * `@@ -0,0 +1,N @@` — every line an addition. The earlier comment here claiming
 * `write` has no patch was wrong, and it mattered: it implied a whole-file write
 * was undiffable, when in fact it is the *easiest* case.
 */

/** A `metadata.files[]` entry that carries a usable patch. */
interface PatchEntry {
  readonly patch: string;
}

/**
 * The patch a tool part's metadata carries, or `null`.
 *
 * Returns null for every shape that is not a non-blank string patch, so callers
 * can treat "no patch" as one case rather than each re-checking the shape.
 *
 * @param metadata - A tool part's `metadata` object, or anything else.
 * @returns The first usable patch, or null.
 */
export function patchFromToolMetadata(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const files = (metadata as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  const entry = files.find(isPatchEntry);
  return entry === undefined ? null : entry.patch;
}

function isPatchEntry(value: unknown): value is PatchEntry {
  if (value === null || typeof value !== "object") return false;
  const patch = (value as { patch?: unknown }).patch;
  return typeof patch === "string" && patch.trim() !== "";
}
