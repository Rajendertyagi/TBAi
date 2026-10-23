import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  existingDatabaseFiles,
  foreignProcessIds,
  OpenCodeDatabaseBusyError,
  OpenCodeDatabaseCheckError,
  OpenCodeDatabaseOwnership,
  OpenCodeDatabasePathError,
  openCodeDatabaseMutexName,
  parseOpenCodeDatabasePath,
  type OpenCodeDatabaseOwnershipDeps,
} from "@/services/opencode/ownership.ts";
import type { NamedMutexLease } from "@/services/process-ownership.ts";

const DB_PATH = path.join(os.tmpdir(), "tbai-ownership-test", "opencode.db");

function tempDatabaseFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-ownership-"));
  const file = path.join(dir, "opencode.db");
  fs.writeFileSync(file, "sqlite");
  return { dir, file };
}

function fakeDeps(overrides: Partial<OpenCodeDatabaseOwnershipDeps> = {}): {
  deps: Partial<OpenCodeDatabaseOwnershipDeps>;
  released: NamedMutexLease[];
} {
  const released: NamedMutexLease[] = [];
  return {
    released,
    deps: {
      platform: "win32",
      pid: 100,
      resolveDatabasePath: async () => DB_PATH,
      findProcessesUsingFiles: () => [],
      acquireMutex: () => ({ handle: 0n }),
      releaseMutex: (lease) => released.push(lease),
      ...overrides,
    },
  };
}

describe("parseOpenCodeDatabasePath", () => {
  it("takes the last non-empty line", () => {
    expect(parseOpenCodeDatabasePath("\r\nC:\\data\\opencode.db\r\n")).toBe(
      "C:\\data\\opencode.db",
    );
  });

  it("refuses empty output instead of guessing a default", () => {
    expect(() => parseOpenCodeDatabasePath("\n \r\n")).toThrow(OpenCodeDatabasePathError);
  });
});

describe("openCodeDatabaseMutexName", () => {
  it("is stable for the same path and ignores Windows case", () => {
    const a = openCodeDatabaseMutexName("C:\\Data\\OpenCode\\opencode.db");
    const b = openCodeDatabaseMutexName("c:\\data\\opencode\\OPENCODE.DB");
    expect(a).toBe(b);
    expect(a.startsWith("Local\\TBAi.OpenCode.Database.")).toBe(true);
  });

  it("differs for different paths", () => {
    expect(openCodeDatabaseMutexName("C:\\a\\opencode.db")).not.toBe(
      openCodeDatabaseMutexName("C:\\b\\opencode.db"),
    );
  });
});

describe("existingDatabaseFiles", () => {
  it("includes only files that exist", () => {
    const { dir, file } = tempDatabaseFile();
    try {
      expect(existingDatabaseFiles(file)).toEqual([file]);
      fs.writeFileSync(`${file}-wal`, "wal");
      expect(existingDatabaseFiles(file)).toEqual([file, `${file}-wal`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the database does not exist yet", () => {
    expect(existingDatabaseFiles(path.join(os.tmpdir(), "tbai-missing", "opencode.db"))).toEqual(
      [],
    );
  });
});

describe("foreignProcessIds", () => {
  it("drops ignored PIDs, duplicates, and non-positive entries", () => {
    expect(foreignProcessIds([100, 200, 200, 0, 300], [100, 300])).toEqual([200]);
  });
});

describe("OpenCodeDatabaseOwnership", () => {
  it("is a no-op off Windows", async () => {
    const { deps } = fakeDeps({ platform: "linux" });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    expect(await lease.acquire("opencode", "C:\\work")).toBeNull();
    await lease.verifyChild(123, DB_PATH);
    lease.release();
  });

  it("exempts :memory: because there is no shared file", async () => {
    const { deps, released } = fakeDeps({ resolveDatabasePath: async () => ":memory:" });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    expect(await lease.acquire("opencode", "C:\\work")).toBeNull();
    expect(released).toEqual([]);
  });

  it("refuses when another TBAi backend holds the named mutex", async () => {
    const { deps, released } = fakeDeps({ acquireMutex: () => null });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    await expect(lease.acquire("opencode", "C:\\work")).rejects.toBeInstanceOf(
      OpenCodeDatabaseBusyError,
    );
    expect(released).toEqual([]);
  });

  it("refuses when a foreign process already holds the database, and releases the mutex", async () => {
    const { dir, file } = tempDatabaseFile();
    const { deps, released } = fakeDeps({
      resolveDatabasePath: async () => file,
      findProcessesUsingFiles: () => [4242],
    });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    try {
      const error = await lease.acquire("opencode", dir).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(OpenCodeDatabaseBusyError);
      if (!(error instanceof OpenCodeDatabaseBusyError)) throw new Error("expected busy error");
      expect(error.details.pids).toEqual([4242]);
      expect(released).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unanswerable Restart Manager query as a refusal, not as 'no holder'", async () => {
    const { dir, file } = tempDatabaseFile();
    const { deps, released } = fakeDeps({
      resolveDatabasePath: async () => file,
      findProcessesUsingFiles: () => {
        throw new Error("RmGetList failed");
      },
    });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    try {
      await expect(lease.acquire("opencode", dir)).rejects.toBeInstanceOf(
        OpenCodeDatabaseCheckError,
      );
      expect(released).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquires a fresh database and verifies that only the managed child holds it", async () => {
    const { dir, file } = tempDatabaseFile();
    let calls = 0;
    const { deps, released } = fakeDeps({
      resolveDatabasePath: async () => file,
      findProcessesUsingFiles: () => {
        calls += 1;
        return calls === 1 ? [100] : [100, 777];
      },
    });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    try {
      expect(await lease.acquire("opencode", dir)).toBe(file);
      await lease.verifyChild(777, file);
      expect(released).toEqual([]);
      lease.release();
      expect(released).toHaveLength(1);
      lease.release();
      expect(released).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when a foreign process opens the database during startup", async () => {
    const { dir, file } = tempDatabaseFile();
    let calls = 0;
    const { deps, released } = fakeDeps({
      resolveDatabasePath: async () => file,
      findProcessesUsingFiles: () => {
        calls += 1;
        return calls === 1 ? [100] : [777, 999];
      },
    });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    try {
      expect(await lease.acquire("opencode", dir)).toBe(file);
      const error = await lease.verifyChild(777, file).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(OpenCodeDatabaseBusyError);
      if (!(error instanceof OpenCodeDatabaseBusyError)) throw new Error("expected busy error");
      expect(error.details.pids).toEqual([999]);
      expect(released).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to verify when the database file never appeared", async () => {
    const { dir, file } = tempDatabaseFile();
    fs.rmSync(file);
    const { deps } = fakeDeps({ resolveDatabasePath: async () => file });
    const lease = new OpenCodeDatabaseOwnership({ deps });
    try {
      expect(await lease.acquire("opencode", dir)).toBe(file);
      await expect(lease.verifyChild(777, file)).rejects.toBeInstanceOf(OpenCodeDatabaseCheckError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
