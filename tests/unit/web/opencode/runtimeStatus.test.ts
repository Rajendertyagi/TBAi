/**
 * The runtime-status wire contract and the surface mapping.
 *
 * ## What this pins
 *
 * §4.1 has exactly three observable states: managed-ready, adopted-ready and
 * unresolved. The browser is told a mode — never an origin, a password or a
 * registration path — and the surface derives its words from that mode alone.
 *
 * ## Why "unresolved" is not presented as an error
 *
 * The managed service starts LAZILY, on the first Code request. A boot that
 * adopted nothing therefore reports `unresolved` until somebody opens Code
 * mode, and calling that "unavailable" would be a claim nothing has tested. The
 * chip adds the unavailable notice only when the runtime has ALSO failed; this
 * module keeps that decision in one place so both the chip and the config page
 * agree about what a mode means.
 */

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
  type OpenCodeRuntimeCapabilities,
  type OpenCodeRuntimeStatus,
} from "@web/features/opencode/runtimeStatus.ts";

const BID = "backend-instance";

const CAPABILITIES: OpenCodeRuntimeCapabilities = {
  version: "2.3.1",
  supported: {
    session: true,
    events: true,
    config: false,
    agent: true,
    model: true,
    command: true,
  },
};

const ADOPTED: OpenCodeRuntimeStatus = {
  mode: "adopted",
  capabilities: CAPABILITIES,
  backendInstanceId: BID,
  targetRevision: 3,
  targetId: 7,
};

describe("parseOpenCodeRuntimeStatus", () => {
  it("accepts the two capability-free modes", () => {
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

  it("carries the adopted capability snapshot", () => {
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: CAPABILITIES,
        backendInstanceId: BID,
        targetRevision: 3,
        targetId: 7,
      }),
    ).toEqual({
      mode: "adopted",
      capabilities: CAPABILITIES,
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 7,
    });
  });

  it("treats a NULL snapshot as unknown, not as everything absent", () => {
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: null,
        backendInstanceId: BID,
        targetRevision: 3,
        targetId: 7,
      }),
    ).toEqual({
      mode: "adopted",
      capabilities: null,
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 7,
    });
  });

  it("treats a PARTIAL snapshot as unknown rather than half-believing it", () => {
    // A half-read snapshot would hide a surface the service does serve.
    const partial = {
      version: "2.3.1",
      supported: { session: true, events: true, config: true, agent: true, model: true },
    };
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: partial,
        backendInstanceId: BID,
        targetRevision: 3,
        targetId: 7,
      }),
    ).toEqual({
      mode: "adopted",
      capabilities: null,
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 7,
    });
  });

  it("rejects a snapshot whose flags are not booleans", () => {
    const wrongType = { ...CAPABILITIES, supported: { ...CAPABILITIES.supported, config: "no" } };
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: wrongType,
        backendInstanceId: BID,
        targetRevision: 3,
        targetId: 7,
      }),
    ).toEqual({
      mode: "adopted",
      capabilities: null,
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 7,
    });
  });

  it("rejects a snapshot with no version", () => {
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: { supported: { session: true } },
        backendInstanceId: BID,
        targetRevision: 3,
        targetId: 7,
      }),
    ).toEqual({
      mode: "adopted",
      capabilities: null,
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 7,
    });
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: { version: "", supported: {} },
        backendInstanceId: BID,
        targetRevision: 3,
        targetId: 7,
      }),
    ).toEqual({
      mode: "adopted",
      capabilities: null,
      backendInstanceId: BID,
      targetRevision: 3,
      targetId: 7,
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
    // A mode this build does not know means the two halves disagree; showing
    // either one would misdescribe which service holds the reader's history.
    expect(() => parseOpenCodeRuntimeStatus({ mode: "remote" })).toThrow(
      "OpenCode returned an unknown runtime status",
    );
  });

  it("rejects a payload that is not an object", () => {
    expect(() => parseOpenCodeRuntimeStatus(null)).toThrow(
      "OpenCode returned an unreadable runtime status",
    );
    expect(() => parseOpenCodeRuntimeStatus("adopted")).toThrow(
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
  it("names each mode without implying who started what", () => {
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
    const adopted = runtimeStatusView(ADOPTED);
    expect(adopted.label).toBe("Adopted service");
    expect(adopted.unresolved).toBe(false);
    expect(adopted.detail).toContain("already running");
  });

  it("marks unresolved as NOT started, and as unresolved", () => {
    const view = runtimeStatusView({
      mode: "unresolved",
      backendInstanceId: BID,
      targetRevision: 0,
      targetId: null,
    });
    expect(view).toEqual({ label: "Not started", detail: null, unresolved: true });
  });

  it("keeps the unavailable sentence with the status that means it", () => {
    // The chip and the config page must not each invent their own wording.
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

  it("does not let an old target event from a previous backend instance roll back an accepted new instance", () => {
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 5, targetId: 5 },
      0,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: "instance-b", targetRevision: 1, targetId: 10 },
      0,
    );
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 99, targetId: 5 },
      0,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 1,
      targetId: 10,
    });
  });

  it("preserves recoveryEpoch behavior across backend restart scenarios", () => {
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-a", targetRevision: 5, targetId: 5 },
      1,
    );
    // New backend instance accepted at same recovery epoch (restart without epoch advance).
    publishRuntimeTargetIdentity(
      { mode: "managed", backendInstanceId: "instance-b", targetRevision: 1, targetId: 10 },
      1,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 1,
      targetId: 10,
    });
    expect(useRuntimeTargetStore.getState().acceptedRecoveryEpoch).toBe(1);

    // Recovery epoch advance still accepted for same/new instance publications.
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "instance-b", targetRevision: 2, targetId: 11 },
      2,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 2,
      targetId: 11,
    });
    expect(useRuntimeTargetStore.getState().acceptedRecoveryEpoch).toBe(2);

    // Older recovery epoch from unknown/legacy identity must not roll back.
    publishRuntimeStatus(
      { mode: "managed", backendInstanceId: "", targetRevision: 99, targetId: 99 },
      1,
    );
    expect(useRuntimeTargetStore.getState().status).toEqual({
      mode: "managed",
      backendInstanceId: "instance-b",
      targetRevision: 2,
      targetId: 11,
    });
  });
});

describe("openCodeCapabilitySupported", () => {
  it("does not hide anything for a managed service (nothing was assessed)", () => {
    expect(
      openCodeCapabilitySupported(
        { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
        "config",
      ),
    ).toBe(true);
    expect(
      openCodeCapabilitySupported(
        { mode: "unresolved", backendInstanceId: BID, targetRevision: 0, targetId: null },
        "config",
      ),
    ).toBe(true);
  });

  it("does not hide anything when the adopted snapshot is unknown", () => {
    expect(
      openCodeCapabilitySupported(
        {
          mode: "adopted",
          capabilities: null,
          backendInstanceId: BID,
          targetRevision: 1,
          targetId: 1,
        },
        "config",
      ),
    ).toBe(true);
  });

  it("degrades only the capability the snapshot positively reports missing", () => {
    expect(openCodeCapabilitySupported(ADOPTED, "config")).toBe(false);
    for (const id of ["session", "events", "agent", "model", "command"] as const) {
      expect(openCodeCapabilitySupported(ADOPTED, id)).toBe(true);
    }
  });
});
