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

import { describe, expect, it } from "bun:test";
import {
  OPENCODE_UNAVAILABLE_NOTICE,
  openCodeCapabilitySupported,
  parseOpenCodeRuntimeStatus,
  readOpenCodeRuntimeStatus,
  runtimeStatusView,
  type OpenCodeRuntimeCapabilities,
  type OpenCodeRuntimeStatus,
} from "@web/features/opencode/runtimeStatus.ts";

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

const ADOPTED: OpenCodeRuntimeStatus = { mode: "adopted", capabilities: CAPABILITIES };

describe("parseOpenCodeRuntimeStatus", () => {
  it("accepts the two capability-free modes", () => {
    expect(parseOpenCodeRuntimeStatus({ mode: "unresolved" })).toEqual({ mode: "unresolved" });
    expect(parseOpenCodeRuntimeStatus({ mode: "managed" })).toEqual({ mode: "managed" });
  });

  it("carries the adopted capability snapshot", () => {
    expect(parseOpenCodeRuntimeStatus({ mode: "adopted", capabilities: CAPABILITIES })).toEqual({
      mode: "adopted",
      capabilities: CAPABILITIES,
    });
  });

  it("treats a NULL snapshot as unknown, not as everything absent", () => {
    expect(parseOpenCodeRuntimeStatus({ mode: "adopted", capabilities: null })).toEqual({
      mode: "adopted",
      capabilities: null,
    });
  });

  it("treats a PARTIAL snapshot as unknown rather than half-believing it", () => {
    // A half-read snapshot would hide a surface the service does serve.
    const partial = {
      version: "2.3.1",
      supported: { session: true, events: true, config: true, agent: true, model: true },
    };
    expect(parseOpenCodeRuntimeStatus({ mode: "adopted", capabilities: partial })).toEqual({
      mode: "adopted",
      capabilities: null,
    });
  });

  it("rejects a snapshot whose flags are not booleans", () => {
    const wrongType = { ...CAPABILITIES, supported: { ...CAPABILITIES.supported, config: "no" } };
    expect(parseOpenCodeRuntimeStatus({ mode: "adopted", capabilities: wrongType })).toEqual({
      mode: "adopted",
      capabilities: null,
    });
  });

  it("rejects a snapshot with no version", () => {
    expect(
      parseOpenCodeRuntimeStatus({
        mode: "adopted",
        capabilities: { supported: { session: true } },
      }),
    ).toEqual({ mode: "adopted", capabilities: null });
    expect(
      parseOpenCodeRuntimeStatus({ mode: "adopted", capabilities: { version: "", supported: {} } }),
    ).toEqual({ mode: "adopted", capabilities: null });
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
    const response = Response.json({ mode: "managed" });
    expect(await readOpenCodeRuntimeStatus(response)).toEqual({ mode: "managed" });
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
    expect(runtimeStatusView({ mode: "managed" })).toEqual({
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
    const view = runtimeStatusView({ mode: "unresolved" });
    expect(view).toEqual({ label: "Not started", detail: null, unresolved: true });
  });

  it("keeps the unavailable sentence with the status that means it", () => {
    // The chip and the config page must not each invent their own wording.
    expect(OPENCODE_UNAVAILABLE_NOTICE).toBe("OpenCode is not available");
  });
});

describe("openCodeCapabilitySupported", () => {
  it("does not hide anything for a managed service (nothing was assessed)", () => {
    expect(openCodeCapabilitySupported({ mode: "managed" }, "config")).toBe(true);
    expect(openCodeCapabilitySupported({ mode: "unresolved" }, "config")).toBe(true);
  });

  it("does not hide anything when the adopted snapshot is unknown", () => {
    expect(openCodeCapabilitySupported({ mode: "adopted", capabilities: null }, "config")).toBe(
      true,
    );
  });

  it("degrades only the capability the snapshot positively reports missing", () => {
    expect(openCodeCapabilitySupported(ADOPTED, "config")).toBe(false);
    for (const id of ["session", "events", "agent", "model", "command"] as const) {
      expect(openCodeCapabilitySupported(ADOPTED, id)).toBe(true);
    }
  });
});
