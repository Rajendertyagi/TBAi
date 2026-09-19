import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  setAutoPolicy,
  getAutoPolicy,
  hydrateAutoPolicy,
  clearAutoPolicy,
  clearAllAutoPolicies,
} from "./sessionAutoPolicy";

/**
 * The session-keyed Auto policy cache.
 *
 * Keyed by the OpenCode sessionId (the identity the event-time read has), NOT
 * the conversation id. It is a synchronous projection of the authoritative
 * `conversation.opencodeAutoApprove`; it fails closed (unknown or absent ⇒
 * manual) and is strictly per-session.
 */

beforeEach(() => {
  clearAllAutoPolicies();
});

afterEach(() => {
  clearAllAutoPolicies();
});

describe("sessionAutoPolicy — fail-closed reads", () => {
  it("an unknown session reads false (manual)", () => {
    expect(getAutoPolicy("ses_unknown")).toBe(false);
  });

  it("an absent session id reads false (manual)", () => {
    expect(getAutoPolicy(undefined)).toBe(false);
  });

  it("session A true does not affect session B", () => {
    setAutoPolicy("ses_A", true);
    expect(getAutoPolicy("ses_A")).toBe(true);
    expect(getAutoPolicy("ses_B")).toBe(false);
  });

  it("session isolation: clearing A leaves B untouched", () => {
    setAutoPolicy("ses_A", true);
    setAutoPolicy("ses_B", true);
    clearAutoPolicy("ses_A");
    expect(getAutoPolicy("ses_A")).toBe(false);
    expect(getAutoPolicy("ses_B")).toBe(true);
  });
});

describe("sessionAutoPolicy — hydration", () => {
  it("hydrate true using the sessionId arms the session", () => {
    hydrateAutoPolicy("ses_hydrate", true);
    expect(getAutoPolicy("ses_hydrate")).toBe(true);
  });

  it("hydrate false using the sessionId keeps the session manual", () => {
    hydrateAutoPolicy("ses_hydrate", false);
    expect(getAutoPolicy("ses_hydrate")).toBe(false);
  });

  it("hydrate is strictly === true — malformed values never arm Auto", () => {
    for (const bad of [undefined, null, "true", 1, {}, "auto"]) {
      hydrateAutoPolicy("ses_bad", bad);
      expect(getAutoPolicy("ses_bad")).toBe(false);
    }
  });

  it("hydrate overwrites a previous value (the config is authoritative)", () => {
    hydrateAutoPolicy("ses_flip", true);
    expect(getAutoPolicy("ses_flip")).toBe(true);
    hydrateAutoPolicy("ses_flip", false);
    expect(getAutoPolicy("ses_flip")).toBe(false);
  });
});