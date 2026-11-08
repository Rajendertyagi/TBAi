import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { stripComments } from "@web/testing/source-scope";

/**
 * The sidebar row's interaction states and its always-on timestamp.
 *
 * Both defects this guards were visible in the approved mockup and absent from
 * the implementation: folder rows rendered no time at all, and a row's hover
 * colour was spelled identically to its active colour, so the open
 * conversation became invisible the moment the pointer entered the list. The
 * guards assert the invariants (one owner for the state pair, hover is a
 * fraction of the accent, every row renders the timestamp) rather than the
 * formatter's line wrapping.
 */
const STYLESHEET = "web/src/styles/globals.css";
const ROW = "web/src/features/sidebar/components/SidebarThreadRow.tsx";
const FOLDER_ROWS = "web/src/features/sidebar/components/FolderConversationRow.tsx";
const FOLDER_HEADER = "web/src/features/sidebar/components/FolderHeader.tsx";
const SIDEBAR = "web/src/components/Sidebar.tsx";
const HOOK = "web/src/features/sidebar/hooks/useConversationsList.ts";

let css: string;
const sources = new Map<string, string>();

/** The declaration block of one `@utility`, up to its column-0 closing brace. */
function utilityBody(source: string, name: string): string | null {
  const match = new RegExp(`@utility\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  return match?.[1] ?? null;
}

beforeAll(async () => {
  css = await Bun.file(path.join(REPO_ROOT, STYLESHEET)).text();
  for (const file of [ROW, FOLDER_ROWS, FOLDER_HEADER, SIDEBAR, HOOK]) {
    sources.set(file, await Bun.file(path.join(REPO_ROOT, file)).text());
  }
});

describe("a sidebar row's states have one owner", () => {
  it("declares the state pair exactly once", () => {
    expect(css).toContain("@utility sidebar-row-surface");
    expect(css.match(/@utility\s+sidebar-row-surface\b/g) ?? []).toHaveLength(1);
  });

  it("lifts hover to a fraction of the accent and keeps active at the full accent", () => {
    const body = utilityBody(css, "sidebar-row-surface");
    expect(body).not.toBeNull();
    expect(body).toMatch(
      /&:not\(\[data-active\]\):hover\s*\{\s*background-color:\s*var\(--sidebar-row-hover\)/,
    );
    expect(body).toMatch(/&\[data-active\][\s\S]*?background-color:\s*var\(--sidebar-accent\)/);
  });

  it("defines the hover fractions as tokens, never as a full accent", () => {
    expect(css).toMatch(
      /--sidebar-row-hover:\s*color-mix\(in srgb, var\(--sidebar-accent\) 70%, transparent\)/,
    );
    expect(css).toMatch(
      /--sidebar-row-hover-soft:\s*color-mix\(in srgb, var\(--sidebar-accent\) 55%, transparent\)/,
    );
  });

  it("no row re-spells hover as the active colour", () => {
    for (const file of [ROW, FOLDER_HEADER]) {
      const source = sources.get(file);
      if (source === undefined) throw new Error(`source not loaded: ${file}`);
      const code = stripComments(source);
      expect(code).not.toContain("hover:bg-sidebar-accent");
    }
    expect(stripComments(sources.get(ROW) ?? "")).toContain("sidebar-row-surface");
    expect(stripComments(sources.get(FOLDER_HEADER) ?? "")).toContain(
      "hover:bg-[var(--sidebar-row-hover)]",
    );
  });

  it("the running dot carries the halo from the stylesheet, not a ring", () => {
    const dot = utilityBody(css, "thread-running-dot");
    expect(dot).not.toBeNull();
    expect(dot).toMatch(/box-shadow:\s*0 0 0 2px color-mix\(in srgb, var\(--success\) 22%/);
  });
});

describe("every sidebar list row renders its timestamp", () => {
  it("the shared row renders the time unconditionally", () => {
    const code = stripComments(sources.get(ROW) ?? "");
    expect(code).toContain("<ThreadLastMessageTime");
    // A conditional (or a caller-supplied flag) is exactly how folder rows lost
    // their time while the Chats list kept it.
    expect(code).not.toContain("showTime");
  });

  it("the folder list no longer opts out of it", () => {
    expect(stripComments(sources.get(FOLDER_ROWS) ?? "")).not.toContain("showTime");
  });
});

describe("the section badge shows the filtered total, not the loaded page", () => {
  it("the list hook reads the server total", () => {
    expect(stripComments(sources.get(HOOK) ?? "")).toContain("data.total");
  });

  it("the sidebar feeds both section counts from their real source", () => {
    const code = stripComments(sources.get(SIDEBAR) ?? "");
    expect(code).toContain("chats.total");
    expect(code).toContain("folderCount");
  });
});
