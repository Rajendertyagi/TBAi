import { afterEach, describe, expect, it } from "bun:test";
import { useAvailabilityStore } from "@web/features/availability/availabilityStore.ts";
import {
  OPENCODE_UNAVAILABLE_NOTICE,
  openCodeCapabilitySupported,
  parseOpenCodeRuntimeStatus,
  publishRuntimeStatus,
  publishRuntimeTargetIdentity,
  readOpenCodeRuntimeStatus,
  resetRuntimeTargetStoreForTests,
  runtimeStatusView,
  useRuntimeTargetStore,
  type OpenCodeRuntimeStatus,
} from "@web/features/opencode/runtimeStatus.ts";

const BID = "backend-instance";

describe("parseOpenCodeRuntimeStatus", () => {
  it("accepts managed and unresolved modes", () => {
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "unresolved",
        backendInstanceId: BID,
        targetRevision: 0,
        targetId: null,
      }),
    ).toEqual({
      mode: "unresolved",
      backendInstanceId: BID,
      targetRevision: 0,
      targetId: null,
    });
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "managed",
        backendInstanceId: BID,
        targetRevision: 2,
        targetId: 5,
      }),
    ).toEqual({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 2,
      targetId: 5,
    });
  });

  it("defaults missing backend instance identity for legacy/unreadable identity fields", () => {
    expect(parseOpenCodeRuntimeStatus({ mode: "managed", targetRevision: 2, targetId: 5 })).toEqual(
      {
        mode: "managed",
        backendInstanceId: "",
        targetRevision: 2,
        targetId: 5,
      },
    );
  });

  it("rejects an unknown mode instead of guessing", () => {
    expect(() => parseOpenCodeRuntimeStatus({ mode: "adopted" })).toThrow(
      "OpenCode returned an unknown runtime status",
    );
    expect(() => parseOpenCodeRuntimeStatus({ mode: "remote" })).toThrow(
      "OpenCode returned an unknown runtime status",
    );
  });

  it("rejects a payload that is not an object", () => {
    expect(() => parseOpenCodeRuntimeStatus(null)).toThrow(
      "OpenCode returned an unreadable runtime status",
    );
    expect(() => parseOpenCodeRuntimeStatus("managed")).toThrow(
      "OpenCode returned an unreadable runtime status",
    );
  });
});

describe("readOpenCodeRuntimeStatus", () => {
  it("reads a successful response", async () => {
    const response = Response.json({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 2,
      targetId: 5,
    });
    expect(await readOpenCodeRuntimeStatus(response)).toEqual({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 2,
      targetId: 5,
    });
  });

  it("carries the server's message on a refusal", async () => {
    const response = Response.json({ error: "OpenCode server unavailable" }, { status: 503 });
    await expect(readOpenCodeRuntimeStatus(response)).rejects.toThrow(
      "OpenCode server unavailable",
    );
  });

  it("falls back to the status when a refusal is not JSON", async () => {
    const response = new Response("<html>nope</html>", { status: 502 });
    await expect(readOpenCodeRuntimeStatus(response)).rejects.toThrow("HTTP 502");
  });
});

describe("runtimeStatusView", () => {
  it("names each mode", () => {
    expect(
      runtimeStatusView({
        mode: "managed",
        backendInstanceId: BID,
        targetRevision: 2,
        targetId: 5,
      }),
    ).toEqual({
      label: "Managed service",
      detail: null,
      unresolved: false,
    });
  });

  it("marks unresolved as not started", () => {
    const view = runtimeStatusView({
      mode: "unresolved",
      backendInstanceId: BID,
      targetRevision: 0,
      targetId: null,
    });
    expect(view).toEqual({ label: "Not started", detail: null, unresolved: true });
  });

  it("keeps the unavailable sentence", () => {
    expect(OPENCODE_UNAVAILABLE_NOTICE).toBe("OpenCode is not available");
  });
});

describe("runtime status publication ordering", () => {
  afterEach(() => {
    resetRuntimeTargetStoreForTests();
    useAvailabilityStore.setState({ recoveryEpoch: 0 });
  });

  it("does not let an older HTTP status overwrite a newer target notification in the same recovery epoch", () => {
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: BID, targetRevision: 2, targetId: 2 },
      0,
    );
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
      0,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 2,
      targetId: 2,
    });
  });

  it("accepts a lower target revision after backend process recovery resets revision when recovery epoch advances", () => {
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 5, targetId: 5 },
      1,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: "instance-b", targetRevision: 1, targetId: 10 },
      2,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 1,
      targetId: 10,
    });
  });

  it("accepts a lower target revision from a new backend instance even without recovery epoch advance", () => {
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 5, targetId: 5 },
      0,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: "instance-b", targetRevision: 1, targetId: 10 },
      0,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 1,
      targetId: 10,
    });
  });

  it("rejects an old in-flight status response from a previous backend instance after a newer instance is accepted", () => {
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 5, targetId: 5 },
      0,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: "instance-b", targetRevision: 1, targetId: 10 },
      0,
    );
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 6, targetId: 6 },
      0,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 1,
      targetId: 10,
    });
  });

  it("keeps target revisions ordered within one backend instance", () => {
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: BID, targetRevision: 2, targetId: 2 },
      0,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
      0,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: BID, targetRevision: 3, targetId: 3 },
      0,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 3,
    });
  });
});

describe("openCodeCapabilitySupported", () => {
  it("does not hide capabilities in managed-only runtime", () => {
    const managed: OpenCodeRuntimeStatus = {
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 1,
      targetId: 1,
    };
    const unresolved: OpenCodeRuntimeStatus = {
      mode: "unresolved",
      backendInstanceId: BID,
      targetRevision: 0,
      targetId: null,
    };
    for (const id of ["session", "events", "config", "agent", "model", "command"] as const) {
      expect(openCodeCapabilitySupported(managed, id)).toBe(true);
      expect(openCodeCapabilitySupported(unresolved, id)).toBe(true);
    }
  });
});
