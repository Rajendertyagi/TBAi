import { describe, it, expect } from "bun:test";
import {
  adoptedHistoryOwner,
  assertSameHistoryOwner,
  describeHistoryOwner,
  historyOwnerFromTarget,
  LOCAL_OWNER,
  OpenCodeHistoryBoundaryError,
  readConversationHistoryOwner,
  sameHistoryOwner,
  serializeHistoryOwner,
  isLoopbackHost,
  canonicalizeServiceOwner,
} from "@/services/opencode/historyBoundary.ts";
import type { OpenCodeTarget } from "@/services/opencode/connectionState.ts";

/**
 * The simplified local/remote conversation ownership model.
 */

function stored(value: string): {
  id: string;
  opencodeSessionId: string;
  opencodeServiceOwner: string;
} {
  return {
    id: "conv-1",
    opencodeSessionId: "ses_a",
    opencodeServiceOwner: value,
  };
}

describe("isLoopbackHost", () => {
  it("recognizes localhost and loopback IPv4/IPv6", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("sub.localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("does not classify 0.0.0.0 or external addresses as loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("opencode.example.com")).toBe(false);
  });
});

describe("canonicalizeServiceOwner", () => {
  it("normalizes managed, empty, and default legacy loopback origins to local", () => {
    expect(canonicalizeServiceOwner("")).toBe("local");
    expect(canonicalizeServiceOwner(null)).toBe("local");
    expect(canonicalizeServiceOwner("managed")).toBe("local");
    expect(canonicalizeServiceOwner("default")).toBe("local");
    expect(canonicalizeServiceOwner("profile:default")).toBe("local");
    expect(canonicalizeServiceOwner("adopted:http://127.0.0.1:28894")).toBe("local");
    expect(canonicalizeServiceOwner("adopted:http://localhost:59013")).toBe("local");
    expect(canonicalizeServiceOwner("adopted:http://[::1]:3000")).toBe("local");
  });

  it("preserves explicit loopback origins as remote to prevent unsafe conflation", () => {
    expect(canonicalizeServiceOwner("remote:http://127.0.0.1:4000")).toBe(
      "remote:http://127.0.0.1:4000",
    );
    expect(canonicalizeServiceOwner("explicit:http://127.0.0.1:4000")).toBe(
      "remote:http://127.0.0.1:4000",
    );
    expect(canonicalizeServiceOwner("profile:explicit:http://127.0.0.1:4000")).toBe(
      "remote:http://127.0.0.1:4000",
    );
  });

  it("preserves non-default custom profile strings rather than silently assigning to local", () => {
    expect(canonicalizeServiceOwner("profile:custom-work")).toBe("profile:custom-work");
    expect(canonicalizeServiceOwner("profile:staging-env")).toBe("profile:staging-env");
  });

  it("canonicalizes external origins to remote:<origin>", () => {
    expect(canonicalizeServiceOwner("adopted:https://opencode.example.com:443/")).toBe(
      "remote:https://opencode.example.com",
    );
    expect(canonicalizeServiceOwner("remote:https://opencode.example.com/")).toBe(
      "remote:https://opencode.example.com",
    );
  });
});

describe("serializeHistoryOwner / adoptedHistoryOwner", () => {
  it("writes the local key for local owners", () => {
    expect(serializeHistoryOwner(LOCAL_OWNER)).toBe("local");
  });

  it("resolves default loopback adopted owner to local", () => {
    expect(serializeHistoryOwner(adoptedHistoryOwner("HTTP://127.0.0.1:51234/"))).toBe("local");
  });

  it("isolates explicit loopback adopted owner as remote", () => {
    const explicitLoopback = adoptedHistoryOwner(
      "http://127.0.0.1:4000",
      "explicit:http://127.0.0.1:4000",
    );
    expect(explicitLoopback.kind).toBe("remote");
    expect(serializeHistoryOwner(explicitLoopback)).toBe("remote:http://127.0.0.1:4000");
  });

  it("resolves non-loopback adopted owner to remote:<origin>", () => {
    expect(serializeHistoryOwner(adoptedHistoryOwner("https://opencode.example.com:443/"))).toBe(
      "remote:https://opencode.example.com",
    );
  });

  it("freezes the value so a caller cannot mutate the shared local owner", () => {
    expect(Object.isFrozen(LOCAL_OWNER)).toBe(true);
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

  it("reads a pointer with a NULL owner as local", () => {
    expect(readConversationHistoryOwner(stored(null as unknown as string))).toEqual(LOCAL_OWNER);
  });

  it("reads a pointer with an absent owner field as local", () => {
    expect(
      readConversationHistoryOwner({
        id: "conv-1",
        opencodeSessionId: "ses_a",
      }),
    ).toEqual(LOCAL_OWNER);
  });

  it("reads a pointer with an empty owner string as local", () => {
    expect(readConversationHistoryOwner(stored(""))).toEqual(LOCAL_OWNER);
  });

  it("reads the legacy managed key as local", () => {
    expect(readConversationHistoryOwner(stored("managed"))).toEqual(LOCAL_OWNER);
  });

  it("reads a legacy loopback adopted key as local", () => {
    expect(readConversationHistoryOwner(stored("adopted:http://127.0.0.1:51234"))).toEqual(
      LOCAL_OWNER,
    );
  });

  it("reads an explicit loopback remote key as remote", () => {
    expect(readConversationHistoryOwner(stored("remote:http://127.0.0.1:4000"))).toEqual({
      kind: "remote",
      origin: "http://127.0.0.1:4000",
      profileId: "explicit:http://127.0.0.1:4000",
    });
  });

  it("reads a remote key as remote", () => {
    expect(readConversationHistoryOwner(stored("remote:https://opencode.example.com"))).toEqual({
      kind: "remote",
      origin: "https://opencode.example.com",
      profileId: "explicit:https://opencode.example.com",
    });
  });
});

describe("historyOwnerFromTarget", () => {
  it("maps an unresolved target to no owner", () => {
    expect(historyOwnerFromTarget({ mode: "unresolved" })).toBeNull();
  });

  it("maps a managed target to local owner", () => {
    const target = {
      mode: "managed",
      baseUrl: "http://127.0.0.1:4000",
      origin: "http://127.0.0.1:4000",
      credential: { kind: "managed", password: "p" },
    } as OpenCodeTarget;
    expect(historyOwnerFromTarget(target)).toEqual(LOCAL_OWNER);
  });

  it("maps a default loopback adopted target to local owner", () => {
    const target = {
      mode: "adopted",
      baseUrl: "http://127.0.0.1:51234",
      origin: "http://127.0.0.1:51234",
      credential: {
        kind: "adopted",
        origin: "http://127.0.0.1:51234",
        password: "p",
      },
      profileId: "default",
    } as OpenCodeTarget;
    expect(historyOwnerFromTarget(target)).toEqual(LOCAL_OWNER);
  });

  it("maps an explicit loopback adopted target to remote owner", () => {
    const target = {
      mode: "adopted",
      baseUrl: "http://127.0.0.1:4000",
      origin: "http://127.0.0.1:4000",
      credential: {
        kind: "adopted",
        origin: "http://127.0.0.1:4000",
        password: "p",
      },
      profileId: "explicit:http://127.0.0.1:4000",
    } as OpenCodeTarget;
    expect(historyOwnerFromTarget(target)).toEqual({
      kind: "remote",
      origin: "http://127.0.0.1:4000",
      profileId: "explicit:http://127.0.0.1:4000",
    });
  });

  it("maps an external adopted target to remote owner", () => {
    const target = {
      mode: "adopted",
      baseUrl: "https://opencode.example.com",
      origin: "https://opencode.example.com",
      credential: {
        kind: "adopted",
        origin: "https://opencode.example.com",
        password: "p",
      },
    } as OpenCodeTarget;
    expect(historyOwnerFromTarget(target)).toEqual({
      kind: "remote",
      origin: "https://opencode.example.com",
      profileId: "explicit:https://opencode.example.com",
    });
  });
});

describe("sameHistoryOwner / describeHistoryOwner", () => {
  it("treats all local owners as the same service regardless of port", () => {
    const a = adoptedHistoryOwner("http://127.0.0.1:51234");
    const b = adoptedHistoryOwner("http://127.0.0.1:51235");
    expect(sameHistoryOwner(LOCAL_OWNER, LOCAL_OWNER)).toBe(true);
    expect(sameHistoryOwner(a, b)).toBe(true);
    expect(sameHistoryOwner(a, LOCAL_OWNER)).toBe(true);
  });

  it("isolates different remote origins including explicit loopback origins", () => {
    const loopbackExplicit = adoptedHistoryOwner(
      "http://127.0.0.1:4000",
      "explicit:http://127.0.0.1:4000",
    );
    const remoteA = adoptedHistoryOwner("https://server-a.com");
    const remoteB = adoptedHistoryOwner("https://server-b.com");
    expect(sameHistoryOwner(remoteA, remoteA)).toBe(true);
    expect(sameHistoryOwner(remoteA, remoteB)).toBe(false);
    expect(sameHistoryOwner(remoteA, LOCAL_OWNER)).toBe(false);
    expect(sameHistoryOwner(loopbackExplicit, LOCAL_OWNER)).toBe(false);
  });

  it("describes each kind without a credential or session id", () => {
    expect(describeHistoryOwner(LOCAL_OWNER)).toBe("the local OpenCode environment");
    expect(describeHistoryOwner(adoptedHistoryOwner("https://opencode.example.com"))).toBe(
      "the remote service at https://opencode.example.com",
    );
  });
});

describe("assertSameHistoryOwner", () => {
  const localA = adoptedHistoryOwner("http://127.0.0.1:51234");
  const localB = adoptedHistoryOwner("http://127.0.0.1:51235");
  const explicitLoopback = adoptedHistoryOwner(
    "http://127.0.0.1:4000",
    "explicit:http://127.0.0.1:4000",
  );
  const remote = adoptedHistoryOwner("https://opencode.example.com");

  it("always allows a conversation with no binding to create one", () => {
    expect(() => assertSameHistoryOwner("conv-1", null, LOCAL_OWNER)).not.toThrow();
    expect(() => assertSameHistoryOwner("conv-1", null, localA)).not.toThrow();
  });

  it("allows switching between local endpoints and ports", () => {
    expect(() => assertSameHistoryOwner("conv-1", localA, localB)).not.toThrow();
    expect(() => assertSameHistoryOwner("conv-1", LOCAL_OWNER, localA)).not.toThrow();
  });

  it("refuses mixing local and explicit loopback server", () => {
    expect(() => assertSameHistoryOwner("conv-1", explicitLoopback, LOCAL_OWNER)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
    expect(() => assertSameHistoryOwner("conv-1", LOCAL_OWNER, explicitLoopback)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
  });

  it("refuses mixing local and remote", () => {
    expect(() => assertSameHistoryOwner("conv-1", remote, LOCAL_OWNER)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
    expect(() => assertSameHistoryOwner("conv-1", LOCAL_OWNER, remote)).toThrow(
      OpenCodeHistoryBoundaryError,
    );
  });
});
