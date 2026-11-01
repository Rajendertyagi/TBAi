import { describe, it, expect } from "bun:test";
import {
  adoptedHistoryOwner,
  assertSameHistoryOwner,
  describeHistoryOwner,
  historyOwnerFromTarget,
  MANAGED_HISTORY_OWNER,
  OpenCodeHistoryBoundaryError,
  readConversationHistoryOwner,
  sameHistoryOwner,
  serializeHistoryOwner,
} from "@/services/opencode/historyBoundary.ts";
import {
  OpenCodeTargetOriginError,
  type OpenCodeTarget,
} from "@/services/opencode/connectionState.ts";

/**
 * The managed/adopted history boundary (H3/B3).
 *
 * These tests pin the persisted key contract and the one refusal it feeds:
 *
 *  - a session id with no owner key is a LEGACY MANAGED binding, because
 *    adoption postdates those rows; reading it as anything else would let an
 *    adopted service claim a managed history;
 *  - an owner key with no session id is not a binding at all;
 *  - a damaged key is refused, never defaulted;
 *  - a recorded owner that is not the service in use is refused, and a
 *    conversation with no binding is always allowed to create one.
 *
 * No database and no service is touched: this module is pure policy.
 */

function stored(value: string): {
  id: string;
  opencodeSessionId: string;
  opencodeServiceOwner: string;
} {
  return { id: "conv-1", opencodeSessionId: "ses_a", opencodeServiceOwner: value };
}

describe("serializeHistoryOwner / adoptedHistoryOwner", () => {
  it("writes the managed key", () => {
    expect(serializeHistoryOwner(MANAGED_HISTORY_OWNER)).toBe("managed");
  });

  it("writes an adopted key with the canonical origin", () => {
    expect(serializeHistoryOwner(adoptedHistoryOwner("HTTP://127.0.0.1:51234/"))).toBe(
      "adopted:http://127.0.0.1:51234",
    );
  });

  it("refuses a non-absolute origin", () => {
    expect(() => adoptedHistoryOwner("127.0.0.1:51234")).toThrow(OpenCodeTargetOriginError);
  });

  it("refuses a non-HTTP(S) origin", () => {
    expect(() => adoptedHistoryOwner("ws://127.0.0.1:51234")).toThrow(OpenCodeTargetOriginError);
  });

  it("freezes the value so a caller cannot mutate the shared managed owner", () => {
    expect(Object.isFrozen(MANAGED_HISTORY_OWNER)).toBe(true);
    expect(Object.isFrozen(adoptedHistoryOwner("http://127.0.0.1:51234"))).toBe(true);
  });
});

describe("readConversationHistoryOwner", () => {
  it("reads an unbound conversation as no owner, even when the key survived", () => {
    expect(
      readConversationHistoryOwner({
        id: "conv-1",
        opencodeSessionId: null,
        opencodeServiceOwner: "adopted:http://127.0.0.1:51234",
      }),
    ).toBeNull();
  });

  it("reads a pointer with a NULL owner as legacy managed", () => {
    expect(readConversationHistoryOwner(stored(null as unknown as string))).toEqual(
      MANAGED_HISTORY_OWNER,
    );
  });

  it("reads a pointer with an absent owner field as legacy managed", () => {
    expect(readConversationHistoryOwner({ id: "conv-1", opencodeSessionId: "ses_a" })).toEqual(
      MANAGED_HISTORY_OWNER,
    );
  });

  it("reads a pointer with an empty owner string as legacy managed", () => {
    expect(readConversationHistoryOwner(stored(""))).toEqual(MANAGED_HISTORY_OWNER);
  });

  it("reads the managed key as managed", () => {
    expect(readConversationHistoryOwner(stored("managed"))).toEqual(MANAGED_HISTORY_OWNER);
  });

  it("reads an adopted key with a canonical origin", () => {
    expect(readConversationHistoryOwner(stored("adopted:http://127.0.0.1:51234"))).toEqual({
      kind: "adopted",
      origin: "http://127.0.0.1:51234",
    });
  });

  it("refuses an uninterpretable key instead of defaulting it", () => {
    expect(() => readConversationHistoryOwner(stored("something-else"))).toThrow(
      OpenCodeHistoryBoundaryError,
    );
    try {
      readConversationHistoryOwner(stored("something-else"));
    } catch (error) {
      const refusal = error as OpenCodeHistoryBoundaryError;
      expect(refusal.refusal).toBe("unreadable");
      // The conversation is named; the session id is not.
      expect(refusal.conversationId).toBe("conv-1");
      expect(refusal.message).not.toContain("ses_a");
    }
  });

  it("refuses an adopted key whose origin cannot be canonicalized", () => {
    for (const value of ["adopted:", "adopted:not-a-url", "adopted:ws://127.0.0.1:1"]) {
      let caught: unknown;
      try {
        readConversationHistoryOwner(stored(value));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OpenCodeHistoryBoundaryError);
      expect((caught as OpenCodeHistoryBoundaryError).refusal).toBe("unreadable");
    }
  });
});

describe("historyOwnerFromTarget", () => {
  it("maps an unresolved target to no owner", () => {
    expect(historyOwnerFromTarget({ mode: "unresolved" })).toBeNull();
  });

  it("maps a managed target to the managed owner", () => {
    const target = {
      mode: "managed",
      baseUrl: "http://127.0.0.1:4000",
      origin: "http://127.0.0.1:4000",
      credential: { kind: "managed", password: "p" },
    } as OpenCodeTarget;
    expect(historyOwnerFromTarget(target)).toEqual(MANAGED_HISTORY_OWNER);
  });

  it("maps an adopted target to its canonical origin", () => {
    const target = {
      mode: "adopted",
      baseUrl: "http://127.0.0.1:51234",
      origin: "http://127.0.0.1:51234",
      credential: { kind: "adopted", origin: "http://127.0.0.1:51234", password: "p" },
    } as OpenCodeTarget;
    expect(historyOwnerFromTarget(target)).toEqual({
      kind: "adopted",
      origin: "http://127.0.0.1:51234",
    });
  });
});

describe("sameHistoryOwner / describeHistoryOwner", () => {
  it("compares kinds and origins", () => {
    const a = adoptedHistoryOwner("http://127.0.0.1:51234");
    expect(sameHistoryOwner(MANAGED_HISTORY_OWNER, MANAGED_HISTORY_OWNER)).toBe(true);
    expect(sameHistoryOwner(a, adoptedHistoryOwner("http://127.0.0.1:51234/"))).toBe(true);
    expect(sameHistoryOwner(a, adoptedHistoryOwner("http://127.0.0.1:51235"))).toBe(false);
    expect(sameHistoryOwner(a, MANAGED_HISTORY_OWNER)).toBe(false);
    expect(sameHistoryOwner(MANAGED_HISTORY_OWNER, a)).toBe(false);
  });

  it("describes each kind without a credential or session id", () => {
    expect(describeHistoryOwner(MANAGED_HISTORY_OWNER)).toBe("the managed service");
    expect(describeHistoryOwner(adoptedHistoryOwner("http://127.0.0.1:51234"))).toBe(
      "the adopted service at http://127.0.0.1:51234",
    );
  });
});

describe("assertSameHistoryOwner", () => {
  const adoptedA = adoptedHistoryOwner("http://127.0.0.1:51234");
  const adoptedB = adoptedHistoryOwner("http://127.0.0.1:51235");

  it("always allows a conversation with no binding to create one", () => {
    expect(() => assertSameHistoryOwner("conv-1", null, MANAGED_HISTORY_OWNER)).not.toThrow();
    expect(() => assertSameHistoryOwner("conv-1", null, adoptedA)).not.toThrow();
  });

  it("allows the same service", () => {
    expect(() =>
      assertSameHistoryOwner("conv-1", MANAGED_HISTORY_OWNER, MANAGED_HISTORY_OWNER),
    ).not.toThrow();
    expect(() => assertSameHistoryOwner("conv-1", adoptedA, adoptedA)).not.toThrow();
  });

  it("refuses a cross-service operation in both directions", () => {
    expect(() => assertSameHistoryOwner("conv-1", adoptedA, MANAGED_HISTORY_OWNER)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
    expect(() => assertSameHistoryOwner("conv-1", MANAGED_HISTORY_OWNER, adoptedA)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
    expect(() => assertSameHistoryOwner("conv-1", adoptedA, adoptedB)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
  });

  it("reports cross_service and names both services, not a secret", () => {
    try {
      assertSameHistoryOwner("conv-1", adoptedA, MANAGED_HISTORY_OWNER);
      throw new Error("expected a refusal");
    } catch (error) {
      const refusal = error as OpenCodeHistoryBoundaryError;
      expect(refusal.refusal).toBe("cross_service");
      expect(refusal.conversationId).toBe("conv-1");
      expect(refusal.message).toContain("the adopted service at http://127.0.0.1:51234");
      expect(refusal.message).toContain("the managed service");
      expect(refusal.message).not.toContain("ses_");
    }
  });
});
