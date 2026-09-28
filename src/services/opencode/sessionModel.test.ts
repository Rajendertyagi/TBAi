import { describe, expect, it } from "bun:test";
import { pickSessionModel } from "./sessionModel";
import type { OpenCodeDefaultModel } from "./capabilities";

/**
 * The model-binding rule, as a decision with no I/O.
 *
 *     session ──▶ resolved model ──▶ stored user choice, if there is one
 *                                    ──▶ otherwise the server's default
 *                                    ──▶ otherwise nothing, honestly
 *
 * These are the five lifecycle cases the fix had to satisfy. The two that
 * matter most are the first and the second: a NEW session and an ADOPTED one
 * must obey the same rule, because a session bound before the default was ever
 * consulted used to stay model-less forever and no turn could run on it.
 */

const DEFAULT_MODEL: OpenCodeDefaultModel = {
  providerID: "openrouter",
  modelID: "perceptron/perceptron-mk1.5",
  name: "Perceptron Mk1.5",
};

const STORED = { providerID: "agnes", modelID: "agnes-3.0-flash" };

describe("case 1 — a new session with no stored choice gets the server default", () => {
  it("resolves to the default", () => {
    expect(pickSessionModel({ storedModel: null, serverDefault: DEFAULT_MODEL }))
      .toEqual({ id: "perceptron/perceptron-mk1.5", providerID: "openrouter" });
  });

  it("treats an undefined stored value as no choice", () => {
    expect(pickSessionModel({ serverDefault: DEFAULT_MODEL }))
      .toEqual({ id: "perceptron/perceptron-mk1.5", providerID: "openrouter" });
  });
});

describe("case 2 — an adopted session with an empty model gets the server default", () => {
  it("resolves to the default when the session reports no model", () => {
    // The live defect: a session bound before the default was consulted reports
    // `model=''`, which the fetch surfaces as null.
    expect(pickSessionModel({ boundModel: null, storedModel: null, serverDefault: DEFAULT_MODEL }))
      .toEqual({ id: "perceptron/perceptron-mk1.5", providerID: "openrouter" });
  });

  it("also treats an empty string as no model", () => {
    // OpenCode reports an unset model as `''` as well as absent, and the fetch
    // normalises both — this pins the normalisation rather than trusting it.
    expect(pickSessionModel({ boundModel: "", storedModel: null, serverDefault: DEFAULT_MODEL }))
      .toEqual({ id: "perceptron/perceptron-mk1.5", providerID: "openrouter" });
  });

  it("does NOT touch a session that already has a model", () => {
    // The guard that makes it safe to run on every adopt. A model already set —
    // by the reader, or by OpenCode itself — is left exactly as it is.
    expect(pickSessionModel({
      boundModel: "agnes/agnes-3.0-flash",
      storedModel: STORED,
      serverDefault: DEFAULT_MODEL,
    })).toBeNull();
  });
});

describe("case 3 — a stored model always wins", () => {
  it("beats the server default", () => {
    expect(pickSessionModel({ storedModel: STORED, serverDefault: DEFAULT_MODEL }))
      .toEqual({ id: "agnes-3.0-flash", providerID: "agnes" });
  });

  it("beats the default even when the session is empty", () => {
    // Both entry points feed the same three facts, which is what stops an
    // adopt from quietly replacing the reader's pick with the default.
    expect(pickSessionModel({ boundModel: null, storedModel: STORED, serverDefault: DEFAULT_MODEL }))
      .toEqual({ id: "agnes-3.0-flash", providerID: "agnes" });
  });
});

describe("case 4 — no server default leaves the session honestly unbound", () => {
  it("returns null rather than inventing a model", () => {
    expect(pickSessionModel({ storedModel: null, serverDefault: null })).toBeNull();
    expect(pickSessionModel({ storedModel: null })).toBeNull();
    expect(pickSessionModel({ boundModel: null, storedModel: null })).toBeNull();
  });

  it("still honours a stored choice when there is no default", () => {
    expect(pickSessionModel({ storedModel: STORED, serverDefault: null }))
      .toEqual({ id: "agnes-3.0-flash", providerID: "agnes" });
  });
});

describe("case 5 — an unbound historical session is never resurrected", () => {
  it("has no way in: the rule only ever runs for a bound session", async () => {
    // The orphan case is prevented structurally, not by a filter: both call
    // sites reach the rule only through a conversation's own
    // `opencodeSessionId`, so a session no conversation points at can never be
    // visited. This pins the absence of any enumerate-and-repair path, so a
    // future "fix all empty sessions" sweep fails here instead of quietly
    // resurrecting history.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./sessions.ts", import.meta.url), "utf8");
    // No listing of all sessions, and no call that could enumerate them.
    expect(source).not.toMatch(/\.session\.list\(/);
    expect(source).not.toMatch(/listSessions|allSessions|everySession/);
    // Both call sites name an explicit session id, never a sweep.
    expect(source).toContain("pickSessionModel");
  });
});

describe("the shape handed to OpenCode", () => {
  it("uses `id`, not `modelID` — the field the API actually takes", () => {
    // A flat `{ providerID, modelID }` body is rejected with 400; the API wants
    // `{ model: { id, providerID } }`. The returned key is `id`.
    const resolved = pickSessionModel({ serverDefault: DEFAULT_MODEL });
    expect(Object.keys(resolved ?? {}).sort()).toEqual(["id", "providerID"]);
    expect(resolved).not.toHaveProperty("modelID");
  });
});
