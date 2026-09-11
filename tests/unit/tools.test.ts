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
  beforeEach(seed);

  it("lists directories dirs-first with sizes", () => {
    const r = runList({ path: "proj" });
    expect(r.entries.map((e) => e.name).sort()).toEqual(["a.ts", "sub"]);
    expect(r.entries[0].type).toBe("dir");
    const file = r.entries.find((e) => e.name === "a.ts")!;
    expect(file.type).toBe("file");
    expect(file.size).toBeGreaterThan(0);
  });

  it("rejects traversal outside the workspace", () => {
    expect(() => runList({ path: "../.." })).toThrow();
    expect(() => resolveSafe("C:/Windows")).toThrow();
  });

  it("searches contents with file:line hits", () => {
    const r = runSearch({ query: "hello", path: "proj" });
    expect(r.filesScanned).toBe(2);
    expect(r.matches.length).toBe(2);
    expect(r.matches[0]).toMatchObject({ line: 2 });
    expect(r.matches[0].snippet).toContain("hello");
  });

  it("searches a single file and caps results", () => {
    const r = runSearch({ query: "hello", path: "proj/a.ts", maxResults: 1 });
    expect(r.matches.length).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it("stats a file", () => {
    const r = runStat({ path: "top.txt" });
    expect(r.type).toBe("file");
    expect(r.size).toBeGreaterThan(0);
    expect(r.modifiedAt).toBeTruthy();
  });

  it("deletes a file but never the workspace root", () => {
    expect(() => runDelete({ path: "." })).toThrow();
    const r = runDelete({ path: "top.txt" });
    expect(r.deleted).toBe(true);
    expect(fs.existsSync(path.join(getWorkspaceDir(), "top.txt"))).toBe(false);
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
