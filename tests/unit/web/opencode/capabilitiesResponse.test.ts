/**
 * M12 — a failed capabilities fetch is an error, never an empty catalogue.
 *
 * The hook's `.catch` keeps the previous agent/model lists, so the only way a
 * 5xx could silently wipe the picker is for the body to parse as a successful
 * catalogue. The proxied error envelope (`{ error }`) is exactly that shape,
 * which is why the response check has to happen before the parse.
 */

import { describe, expect, it } from "bun:test";
import {
  normalizeOpenCodeCapabilities,
  readOpenCodeCapabilities,
} from "@web/features/opencode/useOpenCodeCapabilities.ts";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("readOpenCodeCapabilities", () => {
  it("carries the server's message for a JSON error envelope", async () => {
    await expect(
      readOpenCodeCapabilities(json(503, { error: "opencode not ready" })),
    ).rejects.toThrow("opencode not ready");
  });

  it("reports the status when the error body is not a JSON envelope", async () => {
    await expect(
      readOpenCodeCapabilities(new Response("<html>gateway</html>", { status: 502 })),
    ).rejects.toThrow("HTTP 502");
  });

  it("treats an authoritatively empty catalogue as success", async () => {
    const capabilities = await readOpenCodeCapabilities(
      json(200, {
        agents: [],
        models: [],
        target: {
          backendInstanceId: "b1",
          targetRevision: 1,
          targetId: 1,
          mode: "managed",
        },
      }),
    );
    expect(capabilities.agents).toEqual([]);
    expect(capabilities.models).toEqual([]);
    expect(capabilities.target).toEqual({
      backendInstanceId: "b1",
      targetRevision: 1,
      targetId: 1,
      mode: "managed",
    });
  });
});

describe("normalizeOpenCodeCapabilities", () => {
  it("preserves validation/defaulting semantics for models and defaultModel", () => {
    const normalized = normalizeOpenCodeCapabilities({
      agents: [{ id: "a", name: "A" }],
      models: [
        {
          id: "m1",
          name: "M1",
          providerID: "p",
          limit: { context: 100.7, output: 20.2 },
        } as any,
        {
          id: "m2",
          name: "M2",
          providerID: "p",
          variants: ["x"],
          limit: { context: 0, output: 20 },
        } as any,
      ],
      defaultModel: { providerID: "p", modelID: "m1" } as any,
      target: { backendInstanceId: "b1", targetRevision: 2, targetId: 3, mode: "managed" } as any,
    });

    expect(normalized.models[0]?.variants).toEqual([]);
    expect(normalized.models[0]?.limit).toEqual({ context: 100, output: 20 });
    expect(normalized.models[1]?.variants).toEqual(["x"]);
    expect(normalized.models[1]?.limit).toBeUndefined();
    expect(normalized.defaultModel).toEqual({ providerID: "p", modelID: "m1", name: "m1" });
    expect(normalized.target).toEqual({
      backendInstanceId: "b1",
      targetRevision: 2,
      targetId: 3,
      mode: "managed",
    });
  });
});
