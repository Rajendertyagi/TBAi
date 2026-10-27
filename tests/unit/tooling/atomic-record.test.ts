/**
 * `writeRecordAtomically` is the publication half of a handshake another
 * process polls for.
 *
 * What is provable here is the contract a reader depends on: once the
 * destination exists, it holds every byte, and a re-publish replaces it. The
 * absence of the intermediate state is measured in
 * `tests/integration/opencode/process-ownership.test.ts`'s subject rather than
 * asserted here, because a race cannot be observed deterministically from
 * inside the process that is not racing.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeRecordAtomically } from "../../helpers/atomic-record";

describe("atomic record publication", () => {
  it("leaves exactly the given bytes and no temporary sibling", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-record-"));
    const file = path.join(dir, "shell.json");
    try {
      writeRecordAtomically(file, '{"shellPid":1234}');
      expect(fs.readFileSync(file, "utf8")).toBe('{"shellPid":1234}');
      expect(fs.readdirSync(dir)).toEqual(["shell.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing record instead of appending to it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-record-"));
    const file = path.join(dir, "grandchild");
    try {
      writeRecordAtomically(file, "1:2");
      writeRecordAtomically(file, "1234:56789");
      expect(fs.readFileSync(file, "utf8")).toBe("1234:56789");
      expect(fs.readdirSync(dir)).toEqual(["grandchild"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
