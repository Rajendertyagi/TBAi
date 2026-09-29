import { describe, expect, it } from "bun:test";
import {
  toPermissionRules,
  OpenCodeConfigError,
  addOpenCodePermissionRule,
  fetchOpenCodeConfig,
  removeOpenCodePermissionRule,
  saveOpenCodePermissionEffect,
  type OpenCodePermissionRule,
} from "./openCodeConfig";

/**
 * Boundary tests for the OpenCode config read/write client.
 *
 * These assert on the SHAPE of what crosses the wire and on how untrusted
 * input is narrowed — not on the rendered page. A rule with an effect OpenCode
 * does not accept must be dropped rather than coerced, because showing
 * "Allow" for a rule the server would refuse is a lie the user acts on.
 */

const QUESTION_RULE: OpenCodePermissionRule = {
  action: "question",
  resource: "*",
  effect: "ask",
};

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

describe("toPermissionRules", () => {
  it("returns an empty list for an absent permissions key", () => {
    expect(toPermissionRules(null)).toEqual({ rules: [], skipped: 0 });
    expect(toPermissionRules(undefined)).toEqual({ rules: [], skipped: 0 });
  });

  it("keeps well-formed rules in order", () => {
    const { rules, skipped } = toPermissionRules([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "ask" },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0].action).toBe("shell");
    expect(rules[1].action).toBe("question");
    expect(skipped).toBe(0);
  });

  it("drops a rule whose effect OpenCode does not accept, and counts it", () => {
    const { rules, skipped } = toPermissionRules([
      { action: "question", resource: "*", effect: "maybe" },
      { action: "shell", resource: "*", effect: "ask" },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe("shell");
    expect(skipped).toBe(1);
  });

  it("drops a rule missing action or resource", () => {
    const { rules, skipped } = toPermissionRules([
      { resource: "*", effect: "ask" },
      { action: "shell", effect: "ask" },
      { action: "grep", resource: "*", effect: "deny" },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe("grep");
    expect(skipped).toBe(2);
  });

  it("reports a non-array permissions value rather than pretending it is empty", () => {
    // A legacy object form must not render as "no rules", which would read as
    // "OpenCode has no restrictions".
    expect(toPermissionRules({ question: "ask" })).toEqual({ rules: [], skipped: 1 });
  });

  it("surfaces question and todowrite when the config declares them", () => {
    const { rules } = toPermissionRules([
      { action: "question", resource: "*", effect: "ask" },
      { action: "todowrite", resource: "*", effect: "deny" },
    ]);
    expect(rules.find((r) => r.action === "question")?.effect).toBe("ask");
    expect(rules.find((r) => r.action === "todowrite")?.effect).toBe("deny");
  });
});

describe("fetchOpenCodeConfig", () => {
  it("narrows the response into a snapshot", async () => {
    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({
            path: "C:/cfg/opencode.json",
            discoveredPaths: ["C:/cfg/opencode.json", "D:/home/opencode.json"],
            raw: "{}",
            malformed: false,
            editable: true,
            permissions: [{ action: "question", resource: "*", effect: "ask" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      async () => {
        const snapshot = await fetchOpenCodeConfig();
        expect(snapshot.path).toBe("C:/cfg/opencode.json");
        expect(snapshot.discoveredPaths).toHaveLength(2);
        expect(snapshot.editable).toBe(true);
        expect(snapshot.permissions).toEqual([QUESTION_RULE]);
      },
    );
  });

  it("reports malformed documents as not editable", async () => {
    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({
            path: "C:/cfg/opencode.json",
            discoveredPaths: [],
            raw: "{ broken",
            malformed: true,
            editable: false,
            permissions: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      async () => {
        const snapshot = await fetchOpenCodeConfig();
        expect(snapshot.malformed).toBe(true);
        expect(snapshot.editable).toBe(false);
      },
    );
  });

  it("surfaces the server's own error message on a refusal", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ error: "OpenCode reported no configuration document" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
      async () => {
        await expect(fetchOpenCodeConfig()).rejects.toThrow(
          /no configuration document/,
        );
      },
    );
  });

  it("throws a typed error on a non-JSON body", async () => {
    await withFetch(
      (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
      async () => {
        await expect(fetchOpenCodeConfig()).rejects.toThrow(OpenCodeConfigError);
      },
    );
  });
});

describe("saveOpenCodePermissionEffect", () => {
  it("sends only the rule identity and the new effect, never a document", async () => {
    let sent: { url: string; init?: RequestInit } | null = null;
    await withFetch(
      (async (url: string | URL | Request, init?: RequestInit) => {
        sent = { url: String(url), init };
        return new Response(JSON.stringify({ path: "C:/cfg/opencode.json", changed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      async () => {
        const result = await saveOpenCodePermissionEffect(QUESTION_RULE, "allow");
        expect(result.changed).toBe(true);
        expect(sent?.init?.method).toBe("PUT");
        const body = JSON.parse(String(sent?.init?.body)) as Record<string, unknown>;
        // Preservation is structural: the request has no room to carry a
        // ruleset, so it cannot overwrite one.
        expect(Object.keys(body).sort()).toEqual(["action", "effect", "resource"]);
        expect(body).toEqual({ action: "question", resource: "*", effect: "allow" });
      },
    );
  });

  it("reports changed:false when the rule already had that effect", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ path: "C:/cfg/opencode.json", changed: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
      async () => {
        expect((await saveOpenCodePermissionEffect(QUESTION_RULE, "ask")).changed).toBe(false);
      },
    );
  });

  it("surfaces the backend's refusal instead of pretending it saved", async () => {
    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({ error: "OpenCode configuration is not valid JSON; refusing to write" }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      async () => {
        await expect(saveOpenCodePermissionEffect(QUESTION_RULE, "allow")).rejects.toThrow(
          /refusing to write/,
        );
      },
    );
  });
});

describe("addOpenCodePermissionRule", () => {
  it("POSTs the rule and nothing else — no document, no ruleset", async () => {
    // Preservation is structural: the add request has no room to carry a
    // ruleset, so it cannot overwrite one.
    let sent: { url: string; init?: RequestInit } | null = null;
    await withFetch(
      (async (url: string | URL | Request, init?: RequestInit) => {
        sent = { url: String(url), init };
        return new Response(JSON.stringify({ path: "C:/cfg/opencode.json", changed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      async () => {
        const result = await addOpenCodePermissionRule({
          action: "todowrite",
          resource: "*",
          effect: "deny",
        });
        expect(result.changed).toBe(true);
        expect(sent?.init?.method).toBe("POST");
        expect(JSON.parse(String(sent?.init?.body))).toEqual({
          action: "todowrite",
          resource: "*",
          effect: "deny",
        });
      },
    );
  });

  it("surfaces a duplicate refusal", async () => {
    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({
            error: 'A rule for "question" on "*" already exists; change its effect instead',
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      async () => {
        await expect(addOpenCodePermissionRule(QUESTION_RULE)).rejects.toThrow(
          /already exists/,
        );
      },
    );
  });
});

describe("removeOpenCodePermissionRule", () => {
  it("DELETEs with both the position and the identity", async () => {
    // The identity is what makes a stale index safe: without it the request
    // would be a bare positional delete.
    let sent: { init?: RequestInit } | null = null;
    await withFetch(
      (async (_url: string | URL | Request, init?: RequestInit) => {
        sent = { init };
        return new Response(JSON.stringify({ path: "C:/cfg/opencode.json", changed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      async () => {
        await removeOpenCodePermissionRule(7, QUESTION_RULE);
        expect(sent?.init?.method).toBe("DELETE");
        expect(JSON.parse(String(sent?.init?.body))).toEqual({
          action: "question",
          resource: "*",
          effect: "ask",
          index: 7,
        });
      },
    );
  });

  it("surfaces the stale-position refusal rather than reporting success", async () => {
    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({
            error: "That rule changed on disk since it was read; reload and try again",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      async () => {
        await expect(removeOpenCodePermissionRule(3, QUESTION_RULE)).rejects.toThrow(
          /changed on disk/,
        );
      },
    );
  });
});
