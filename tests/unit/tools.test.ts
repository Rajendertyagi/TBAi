import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import path from "path";
import {
  runList,
  runSearch,
  runStat,
  runDelete,
  runProcesses,
  runSysinfo,
  runKill,
  resolveSafe,
  canonicalizeRoot,
  getWorkspaceDir,
} from "../../src/services/tools";

// Workspace isolation guard: tests/setup.ts redirects WORKSPACE_DIR to tmp.
describe("test workspace isolation", () => {
  it("never points at the real workspace", () => {
    expect(getWorkspaceDir()).toContain("tbai-test");
  });
});

function seed() {
  const root = getWorkspaceDir();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "proj", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "proj", "a.ts"), "const x = 1;\n// hello world\n");
  fs.writeFileSync(path.join(root, "proj", "sub", "b.md"), "# Title\nhello again\n");
  fs.writeFileSync(path.join(root, "top.txt"), "nothing to see\n");
}

describe("coding tools", () => {
  let root = "";
  beforeEach(() => {
    seed();
    root = getWorkspaceDir();
  });

  it("lists directories dirs-first with sizes", () => {
    const r = runList({ path: "proj" }, root);
    expect(r.entries.map((e) => e.name).sort()).toEqual(["a.ts", "sub"]);
    expect(r.entries[0].type).toBe("dir");
    const file = r.entries.find((e) => e.name === "a.ts")!;
    expect(file.type).toBe("file");
    expect(file.size).toBeGreaterThan(0);
  });

  it("rejects traversal outside the workspace", () => {
    expect(() => runList({ path: "../.." }, root)).toThrow();
    expect(() => resolveSafe("C:/Windows", root)).toThrow();
  });

  it("searches contents with file:line hits", () => {
    const r = runSearch({ query: "hello", path: "proj" }, root);
    expect(r.filesScanned).toBe(2);
    expect(r.matches.length).toBe(2);
    expect(r.matches[0]).toMatchObject({ line: 2 });
    expect(r.matches[0].snippet).toContain("hello");
  });

  it("searches a single file and caps results", () => {
    const r = runSearch({ query: "hello", path: "proj/a.ts", maxResults: 1 }, root);
    expect(r.matches.length).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("stats a file", () => {
    const r = runStat({ path: "top.txt" }, root);
    expect(r.type).toBe("file");
    expect(r.size).toBeGreaterThan(0);
    expect(r.modifiedAt).toBeTruthy();
  });

  it("deletes a file but never the workspace root", () => {
    expect(() => runDelete({ path: "." }, root)).toThrow();
    const r = runDelete({ path: "top.txt" }, root);
    expect(r.deleted).toBe(true);
    expect(fs.existsSync(path.join(getWorkspaceDir(), "top.txt"))).toBe(false);
  });
});

describe("canonical containment", () => {
  beforeEach(seed);

  it("canonicalizeRoot resolves symlinked roots to their real location", () => {
    const root = getWorkspaceDir();
    const link = path.join(root, "rootlink");
    try {
      fs.symlinkSync(path.join(root, "proj"), link, "junction");
    } catch {
      return; // symlink privilege unavailable; containment below still holds
    }
    expect(canonicalizeRoot(link)).toBe(fs.realpathSync(path.join(root, "proj")));
  });

  it("admits inside-paths when the root itself is a symlink", () => {
    const root = getWorkspaceDir();
    const link = path.join(root, "rootlink");
    try {
      fs.symlinkSync(path.join(root, "proj"), link, "junction");
    } catch {
      return;
    }
    expect(() => resolveSafe("a.ts", link)).not.toThrow();
    expect(() => resolveSafe("..", link)).toThrow();
  });

  it("rejects symlink escapes regardless of root case", () => {
    const root = getWorkspaceDir();
    const outside = path.join(root, "..", "outside-target");
    fs.mkdirSync(outside, { recursive: true });
    const link = path.join(root, "proj", "evil");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return;
    }
    expect(() => resolveSafe("proj/evil", root)).toThrow(/escapes the workspace/);
    expect(() => resolveSafe("proj/evil", root.toUpperCase())).toThrow(/escapes the workspace/);
  });

  it("compares roots case-insensitively on Windows", () => {
    const root = getWorkspaceDir();
    expect(() => resolveSafe("proj", root.toUpperCase())).not.toThrow();
    expect(() => resolveSafe("../..", root.toUpperCase())).toThrow(/outside the workspace/);
  });

  it("requires an explicit root (no silent fallback)", () => {
    expect(() =>
      resolveSafe("proj", undefined as unknown as string),
    ).toThrow(/No workspace root/);
  });
});

describe("computer tools", () => {
  it("lists processes with pid + name", () => {
    const r = runProcesses();
    expect(r.count).toBeGreaterThan(0);
    expect(r.processes[0].pid).toBeGreaterThan(0);
    expect(r.processes[0].name).toBeTruthy();
  });

  it("refuses to kill system processes and itself", () => {
    expect(() => runKill({ pid: 4 })).toThrow();
    expect(() => runKill({ pid: process.pid })).toThrow();
    expect(() => runKill({ pid: -1 })).toThrow();
  });

  it("reports system info", async () => {
    const r = await runSysinfo();
    expect(r.cpuCount).toBeGreaterThan(0);
    expect(r.totalMemoryMB).toBeGreaterThan(0);
    expect(r.platform).toBeTruthy();
  });
});
