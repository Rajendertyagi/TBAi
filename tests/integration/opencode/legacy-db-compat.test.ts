import { describe, expect, it } from "bun:test";
import {
  type LegacyEvidenceRecord,
  validateLegacyEvidenceRecord,
} from "../../helpers/opencodeEvidenceRecord";

/**
 * LB1 + LB5 — a recorded observation is read only when it can name the build
 * and the process that produced it.
 *
 * The records here are synthetic. LB2/LB3/LB6/LB7 need a process-level file
 * trace of the owner's running service, which requires elevation and is
 * BLOCKED; this file tests the record contract those runs must satisfy, which
 * is exactly what LB1 asks for. A passing record here is NOT a runtime
 * measurement, and no test in this file claims one.
 *
 * LB4's runtime half (a build that writes no registration falls back to the
 * managed service and reports it as such) is exercised where the runtime lives:
 * `tests/integration/opencode/startup-orchestration.test.ts` — the
 * `registration_missing` case asserts `status: "managed"`.
 */

const PACKAGE_SHA = "a".repeat(64);
const EXECUTABLE_SHA = "b".repeat(64);
const IMAGE_PATH = "D:\\evidence\\2.0.15\\package\\bin\\opencode.exe";

const launcher = {
  pid: 100,
  parentPid: 99,
  imagePath: "C:\\Windows\\System32\\cmd.exe",
  imageSha256: "c".repeat(64),
  startedAt: "2026-10-31T09:00:00.000Z",
};

const service = {
  pid: 200,
  parentPid: 100,
  imagePath: IMAGE_PATH,
  imageSha256: EXECUTABLE_SHA,
  startedAt: "2026-10-31T09:00:01.000Z",
};

const base: LegacyEvidenceRecord = {
  version: "2.0.15",
  kind: "real-build",
  isolationRoot: "D:\\evidence\\2.0.15\\root",
  extraction: {
    provenance: "package extraction",
    packageName: "opencode-windows-x64.zip",
    packageSha256: PACKAGE_SHA,
    packageIntegrity: "sha512-deadbeef",
    executablePath: IMAGE_PATH,
    executableSha256: EXECUTABLE_SHA,
    executableMember: "bin/opencode.exe",
  },
  registration: { path: "D:\\evidence\\2.0.15\\root\\registration.json", written: false },
  serviceImagePid: 200,
  processTree: [launcher, service],
  observation: {
    targetFile: "D:\\evidence\\2.0.15\\root\\opencode.db",
    operation: "CreateFile",
    requestedAccess: "ReadData/WriteData",
    disposition: "OPENED",
    timestamp: "2026-10-31T09:00:02.000Z",
  },
};

const bare: LegacyEvidenceRecord = {
  ...base,
  extraction: {
    provenance: "bare executable",
    executablePath: IMAGE_PATH,
    executableSha256: EXECUTABLE_SHA,
  },
};

describe("LB1 — the composite build identity", () => {
  it("accepts a packaged build and keys it on package + executable", () => {
    const result = validateLegacyEvidenceRecord(base);
    expect(result.status).toBe("pass");
    if (result.status !== "pass") return;
    expect(result.key).toContain("2.0.15");
    expect(result.key).toContain("opencode-windows-x64.zip");
    expect(result.key).toContain(PACKAGE_SHA);
    expect(result.key).toContain(EXECUTABLE_SHA);
  });

  it("accepts a bare executable under its literal provenance", () => {
    const result = validateLegacyEvidenceRecord(bare);
    expect(result.status).toBe("pass");
    if (result.status !== "pass") return;
    expect(result.key).toContain("bare executable");
    expect(result.key).not.toContain("undefined");
  });

  it("keeps two packages with one executable digest as two records", () => {
    const first = validateLegacyEvidenceRecord(base);
    const second = validateLegacyEvidenceRecord({
      ...base,
      extraction: { ...base.extraction, packageSha256: "d".repeat(64) },
    });
    expect(first.status).toBe("pass");
    expect(second.status).toBe("pass");
    if (first.status !== "pass" || second.status !== "pass") return;
    expect(first.key).not.toBe(second.key);
  });

  it("refuses a record keyed on the executable alone", () => {
    // The plan's finding 80: an executable digest is not a build identity.
    const result = validateLegacyEvidenceRecord({
      ...base,
      extraction: {
        provenance: "package extraction",
        executablePath: IMAGE_PATH,
        executableSha256: EXECUTABLE_SHA,
      },
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.fields).toContain("extraction.packageName");
    expect(result.fields).toContain("extraction.packageSha256");
  });

  it("refuses a single digest that does not say what it belongs to", () => {
    const result = validateLegacyEvidenceRecord({ ...base, digest: EXECUTABLE_SHA });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("unlabelled_digest");
  });

  it("refuses a package record that invents package fields for a bare run", () => {
    const result = validateLegacyEvidenceRecord({
      ...bare,
      extraction: {
        ...bare.extraction,
        packageName: "something.zip",
        executableMember: "bin/opencode.exe",
      },
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.fields).toContain("extraction.packageName");
  });

  it("refuses an empty integrity value rather than treating it as evidence", () => {
    const result = validateLegacyEvidenceRecord({
      ...base,
      extraction: { ...base.extraction, packageIntegrity: "" },
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.fields).toContain("extraction.packageIntegrity");
  });

  it("refuses a record whose process tree does not reach the service image", () => {
    const result = validateLegacyEvidenceRecord({
      ...base,
      processTree: [launcher],
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("process_tree_unresolved");
  });

  it("refuses a tree that loops instead of terminating at the launcher", () => {
    const result = validateLegacyEvidenceRecord({
      ...base,
      processTree: [
        { ...launcher, pid: 100, parentPid: 200 },
        { ...service, pid: 200, parentPid: 100 },
      ],
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("process_tree_unresolved");
  });

  it("refuses an attribution PID that names the launcher, not the service image", () => {
    // The launcher's image does not hash to the executable digest, so pointing
    // the primary identity at it is the exact mistake LB7 exists to catch.
    const result = validateLegacyEvidenceRecord({ ...base, serviceImagePid: 100 });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("image_digest_mismatch");
  });

  it("refuses an attribution PID whose image digest is not the executable", () => {
    // Same path, different bytes: the attribution is still not this build.
    const result = validateLegacyEvidenceRecord({
      ...base,
      processTree: [launcher, { ...service, imageSha256: "e".repeat(64) }],
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("image_digest_mismatch");
  });

  it("refuses a non-record", () => {
    for (const value of [null, [], "record", 7]) {
      const result = validateLegacyEvidenceRecord(value);
      expect(result.status).toBe("rejected");
    }
  });
});

describe("LB1 — every required part is required", () => {
  const missing: Array<{ part: string; record: unknown }> = [
    { part: "version", record: { ...base, version: "  " } },
    { part: "kind", record: { ...base, kind: "human" } },
    { part: "isolationRoot", record: { ...base, isolationRoot: "" } },
    {
      part: "provenance",
      record: { ...base, extraction: { ...base.extraction, provenance: undefined } },
    },
    {
      part: "executablePath",
      record: { ...base, extraction: { ...base.extraction, executablePath: "" } },
    },
    {
      part: "executableSha256",
      record: { ...base, extraction: { ...base.extraction, executableSha256: "b".repeat(63) } },
    },
    {
      part: "executableMember",
      record: { ...base, extraction: { ...base.extraction, executableMember: undefined } },
    },
    { part: "registration", record: { ...base, registration: undefined } },
    {
      part: "registration.written",
      record: { ...base, registration: { path: base.registration.path } },
    },
    { part: "serviceImagePid", record: { ...base, serviceImagePid: 0 } },
    { part: "processTree", record: { ...base, processTree: [] } },
    { part: "observation", record: { ...base, observation: undefined } },
    {
      part: "observation.targetFile",
      record: { ...base, observation: { ...base.observation, targetFile: "" } },
    },
    {
      part: "observation.operation",
      record: { ...base, observation: { ...base.observation, operation: undefined } },
    },
    {
      part: "observation.requestedAccess",
      record: { ...base, observation: { ...base.observation, requestedAccess: undefined } },
    },
    {
      part: "observation.disposition",
      record: { ...base, observation: { ...base.observation, disposition: undefined } },
    },
    {
      part: "observation.timestamp",
      record: { ...base, observation: { ...base.observation, timestamp: "not a time" } },
    },
  ];

  for (const { part, record } of missing) {
    it(`rejects a record without ${part}`, () => {
      const result = validateLegacyEvidenceRecord(record);
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") return;
      expect(result.fields.length).toBeGreaterThan(0);
    });
  }
});

describe("LB5 — a shim run is never build evidence", () => {
  it("rejects a complete record that is tagged as a shim", () => {
    const result = validateLegacyEvidenceRecord({ ...base, kind: "shim" });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("shim_provenance");
  });
});
