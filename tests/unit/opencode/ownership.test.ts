import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  existingDatabaseFiles,
  OpenCodeDatabaseOwnership,
  OpenCodeDatabasePathError,
  parseOpenCodeDatabasePath,
  resolveOpenCodeDatabasePath,
} from "@/services/opencode/ownership.ts";

const DB_PATH = path.join(os.tmpdir(), "tbai-ownership-test", "opencode.db");

function tempDatabaseFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-ownership-"));
  const file = path.join(dir, "opencode.db");
  fs.writeFileSync(file, "sqlite");
  return { dir, file };
}

describe("parseOpenCodeDatabasePath", () => {
  it("returns the last non-empty line", () => {
    expect(parseOpenCodeDatabasePath("\n  /tmp/opencode.db  \n")).toBe("/tmp/opencode.db");
  });

  it("throws on empty output", () => {
    expect(() => parseOpenCodeDatabasePath(" \n ")).toThrow(OpenCodeDatabasePathError);
  });
});

describe("existingDatabaseFiles", () => {
  it("returns only files that exist", () => {
    const { dir, file } = tempDatabaseFile();
    try {
      expect(existingDatabaseFiles(file)).toEqual([file]);
      fs.writeFileSync(`${file}-wal`, "wal");
      expect(existingDatabaseFiles(file)).toEqual([file, `${file}-wal`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveOpenCodeDatabasePath", () => {
  it("throws a path error when the binary cannot be run", async () => {
    await expect(
      resolveOpenCodeDatabasePath("definitely-not-a-real-opencode-binary", process.cwd(), 500),
    ).rejects.toBeInstanceOf(OpenCodeDatabasePathError);
  });
});

describe("OpenCodeDatabaseOwnership", () => {
  it("acquires the lease, verifies the managed child, and releases the mutex when no foreign holder exists", async () => {
    const { dir, file } = tempDatabaseFile();
    let resolveCalls = 0;
    let holderCalls = 0;
    let mutexAcquireCalls = 0;
    let mutexReleaseCalls = 0;
    const lease = new OpenCodeDatabaseOwnership({
      deps: {
        platform: "win32",
        pid: 111,
        resolveDatabasePath: async () => {
          resolveCalls += 1;
          return file;
        },
        findProcessesUsingFiles: () => {
          holderCalls += 1;
          // acquire(): no foreign holders; verifyChild(): managed child holds the DB.
          return holderCalls === 1 ? [] : [777];
        },
        acquireMutex: () => {
          mutexAcquireCalls += 1;
          return { handle: 1n as unknown as never };
        },
        releaseMutex: () => {
          mutexReleaseCalls += 1;
        },
      },
    });

    try {
      await expect(lease.acquire("opencode", "C:\\work")).resolves.toBe(file);
      await expect(lease.verifyChild(777, file)).resolves.toBeUndefined();
      lease.release();

      expect(resolveCalls).toBe(1);
      expect(holderCalls).toBeGreaterThanOrEqual(2);
      expect(mutexAcquireCalls).toBe(1);
      expect(mutexReleaseCalls).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an in-memory database without locking or holder inspection", async () => {
    let holderCalls = 0;
    let mutexCalls = 0;
    const lease = new OpenCodeDatabaseOwnership({
      deps: {
        platform: "win32",
        resolveDatabasePath: async () => ":memory:",
        findProcessesUsingFiles: () => {
          holderCalls += 1;
          return [4242];
        },
        acquireMutex: () => {
          mutexCalls += 1;
          return { handle: 0n as unknown as never };
        },
        releaseMutex: () => {
          mutexCalls += 1;
        },
      },
    });

    await expect(lease.acquire("opencode", "C:\\work")).resolves.toBeNull();
    expect(holderCalls).toBe(0);
    expect(mutexCalls).toBe(0);
  });

  it("skips resolution on non-Windows platforms", async () => {
    let resolveCalls = 0;
    const lease = new OpenCodeDatabaseOwnership({
      deps: {
        platform: "linux",
        resolveDatabasePath: async () => {
          resolveCalls += 1;
          return DB_PATH;
        },
      },
    });

    await expect(lease.acquire("opencode", "C:\\work")).resolves.toBeNull();
    expect(resolveCalls).toBe(0);
  });

  it("propagates database path resolution failures", async () => {
    const lease = new OpenCodeDatabaseOwnership({
      deps: {
        platform: "win32",
        resolveDatabasePath: async () => {
          throw new OpenCodeDatabasePathError("cannot resolve");
        },
      },
    });

    await expect(lease.acquire("opencode", "C:\\work")).rejects.toBeInstanceOf(
      OpenCodeDatabasePathError,
    );
  });
});
