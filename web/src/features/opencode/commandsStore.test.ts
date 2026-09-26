/**
 * The command-feed store's load discipline.
 *
 * Fixtures mirror the verified live `GET /command` shape (2 commands with
 * `hints`, 22 skills tagged `source: "skill"`, no `agent`/`model` on the
 * wire). Deterministic: `Date.now` is stubbed (TTL control) and `fetch` is
 * stubbed with deferred barriers for the single-flight race — no sleeps.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  useCommandsStore,
  resetCommandsFeedForTests,
  OPENCODE_COMMANDS_PATH,
} from "./commandsStore";
import { logger } from "../../lib/logger";

/** Live-shaped command entry: hints present, template carries $ARGUMENTS. */
const INIT = {
  name: "init",
  description: "guided AGENTS.md setup",
  source: "command",
  template: "Create or update `AGENTS.md`.\n\nFocus: $ARGUMENTS",
  hints: ["$ARGUMENTS"],
};

/** Live-shaped command entry: subtask present (as on `review`). */
const REVIEW = {
  name: "review",
  description: "review changes",
  source: "command",
  template: "You are a code reviewer.\n\nInput: $ARGUMENTS",
  hints: ["$ARGUMENTS"],
  subtask: true,
};

/** Live-shaped skill entry: no hints/subtask/agent/model on the wire. */
function skill(name: string) {
  return {
    name,
    description: `Skill ${name}`,
    source: "skill",
    template: `# ${name}\n\nInstruction body without placeholders.`,
  };
}

const FEED_A = [INIT, REVIEW, skill("brainstorming"), skill("paseo")];
const FEED_B = [INIT, skill("officecli")];

function ok(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function failing(status: number) {
  return { ok: false, status, json: async () => null } as Response;
}

function rejectingJson() {
  return { ok: true, status: 200, json: async () => Promise.reject(new Error("bad json")) } as unknown as Response;
}

function deferred() {
  let resolve!: (v: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realWarn = logger.warn;
const realInfo = logger.info;

let nowMs = 1_000_000;
let fetchCalls = 0;
let warnCalls: Array<{ scope: string; event: string; fields: Record<string, unknown> }>;
let infoCalls: Array<{ scope: string; event: string; fields: Record<string, unknown> }>;

beforeEach(() => {
  nowMs = 1_000_000;
  fetchCalls = 0;
  warnCalls = [];
  infoCalls = [];
  Date.now = () => nowMs;
  logger.warn = ((scope: string, event: string, fields: Record<string, unknown> = {}) => {
    warnCalls.push({ scope, event, fields });
  }) as typeof logger.warn;
  logger.info = ((scope: string, event: string, fields: Record<string, unknown> = {}) => {
    infoCalls.push({ scope, event, fields });
  }) as typeof logger.info;
  resetCommandsFeedForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  logger.warn = realWarn;
  logger.info = realInfo;
  resetCommandsFeedForTests();
});

function stubFetch(responder: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls++;
    expect(String(url)).toBe(OPENCODE_COMMANDS_PATH);
    return responder();
  }) as typeof fetch;
}

function seedCache() {
  useCommandsStore.setState({
    commands: [...FEED_A],
    loading: false,
    error: null,
    loadedAt: nowMs,
  });
}

describe("commandsStore — valid feed handling", () => {
  it("replaces the cache on a valid 200 response", async () => {
    seedCache();
    stubFetch(() => ok(FEED_B));
    await useCommandsStore.getState().load({ force: true });
    const s = useCommandsStore.getState();
    expect(s.commands.map((c) => c.name)).toEqual(["init", "officecli"]);
    expect(s.error).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.loadedAt).toBe(nowMs);
  });

  it("populates an empty store from a valid 200 response", async () => {
    stubFetch(() => ok(FEED_A));
    await useCommandsStore.getState().load();
    const s = useCommandsStore.getState();
    expect(s.commands).toHaveLength(4);
    expect(s.commands.filter((c) => c.source === "skill")).toHaveLength(2);
    expect(s.loadedAt).toBe(nowMs);
  });

  it("a successful refresh clears prior error state", async () => {
    useCommandsStore.setState({
      commands: [...FEED_A],
      loading: false,
      error: "Failed to load commands (500)",
      loadedAt: 0,
    });
    stubFetch(() => ok(FEED_B));
    await useCommandsStore.getState().load({ force: true });
    const s = useCommandsStore.getState();
    expect(s.error).toBeNull();
    expect(s.commands.map((c) => c.name)).toEqual(["init", "officecli"]);
  });
});

describe("commandsStore — corrupt/empty 200 retention (the fix)", () => {
  it("retains the old cache on an empty-array 200", async () => {
    seedCache();
    stubFetch(() => ok([]));
    await useCommandsStore.getState().load({ force: true });
    const s = useCommandsStore.getState();
    expect(s.commands.map((c) => c.name)).toEqual(["init", "review", "brainstorming", "paseo"]);
    expect(s.loading).toBe(false);
  });

  it("retains the old cache on a malformed (non-array) 200 payload", async () => {
    seedCache();
    for (const bad of [{}, "nope", 42, null, { commands: FEED_A }]) {
      stubFetch(() => ok(bad));
      await useCommandsStore.getState().load({ force: true });
      expect(useCommandsStore.getState().commands).toHaveLength(4);
    }
  });

  it("retains the old cache when json() itself rejects", async () => {
    seedCache();
    stubFetch(() => rejectingJson());
    await useCommandsStore.getState().load({ force: true });
    expect(useCommandsStore.getState().commands).toHaveLength(4);
  });

  it("retains the old cache when every entry is invalid", async () => {
    seedCache();
    stubFetch(() => ok([null, 42, {}, { name: "" }, { name: 123 }]));
    await useCommandsStore.getState().load({ force: true });
    expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
      "init",
      "review",
      "brainstorming",
      "paseo",
    ]);
  });

  it("an empty/malformed 200 with no previous cache remains empty", async () => {
    stubFetch(() => ok([]));
    await useCommandsStore.getState().load();
    expect(useCommandsStore.getState().commands).toEqual([]);
    stubFetch(() => ok({ nope: true }));
    await useCommandsStore.getState().load({ force: true });
    expect(useCommandsStore.getState().commands).toEqual([]);
  });

  it("a corrupt 200 does not advance loadedAt", async () => {
    seedCache();
    const before = useCommandsStore.getState().loadedAt;
    nowMs += 5_000;
    stubFetch(() => ok([]));
    await useCommandsStore.getState().load({ force: true });
    expect(useCommandsStore.getState().loadedAt).toBe(before);
  });

  it("corrupt payload logs feed_failed with empty_or_invalid_payload metadata", async () => {
    seedCache();
    stubFetch(() => ok([]));
    await useCommandsStore.getState().load({ force: true });
    const entry = warnCalls.find((c) => c.event === "command.feed_failed");
    expect(entry).toBeDefined();
    expect(entry!.scope).toBe("opencode");
    expect(entry!.fields).toMatchObject({
      status: 200,
      reason: "empty_or_invalid_payload",
      retained: 4,
    });
    // No template/instruction content may leak into the log fields.
    expect(JSON.stringify(entry!.fields)).not.toContain("AGENTS.md");
    expect(JSON.stringify(entry!.fields)).not.toContain("Instruction body");
  });
});

describe("commandsStore — TTL, single-flight, failure retention", () => {
  it("does not refetch within the TTL", async () => {
    seedCache();
    stubFetch(() => ok(FEED_B));
    nowMs += 29_999;
    await useCommandsStore.getState().load();
    expect(fetchCalls).toBe(0);
    expect(useCommandsStore.getState().commands).toHaveLength(4);
  });

  it("refreshes once the TTL expires", async () => {
    seedCache();
    stubFetch(() => ok(FEED_B));
    nowMs += 30_000;
    await useCommandsStore.getState().load();
    expect(fetchCalls).toBe(1);
    expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
      "init",
      "officecli",
    ]);
  });

  it("concurrent loads share a single fetch", async () => {
    stubFetch(() => ok(FEED_A));
    const gate = deferred();
    globalThis.fetch = (() => {
      fetchCalls++;
      return gate.promise;
    }) as unknown as typeof fetch;
    const s = useCommandsStore.getState();
    const p1 = s.load();
    const p2 = s.load();
    expect(fetchCalls).toBe(1);
    gate.resolve(ok(FEED_A));
    await Promise.all([p1, p2]);
    expect(fetchCalls).toBe(1);
    expect(useCommandsStore.getState().commands).toHaveLength(4);
  });

  it("HTTP non-OK retains the existing cache", async () => {
    seedCache();
    stubFetch(() => failing(500));
    await useCommandsStore.getState().load({ force: true });
    const s = useCommandsStore.getState();
    expect(s.commands).toHaveLength(4);
    expect(s.error).toContain("500");
    expect(warnCalls.find((c) => c.event === "command.feed_failed")?.fields).toMatchObject({
      status: 500,
      retained: 4,
    });
  });

  it("network failure retains the existing cache", async () => {
    seedCache();
    globalThis.fetch = (() => {
      fetchCalls++;
      return Promise.reject(new TypeError("fetch failed"));
    }) as unknown as typeof fetch;
    await useCommandsStore.getState().load({ force: true });
    const s = useCommandsStore.getState();
    expect(s.commands).toHaveLength(4);
    expect(s.loading).toBe(false);
    expect(s.error).toContain("fetch failed");
  });

  it("repeated mixed loads never corrupt the cache", async () => {
    const responses: Array<() => Response | Promise<Response>> = [
      () => ok(FEED_A),
      () => ok([]),
      () => ok(FEED_B),
      () => failing(503),
      () => ok({ garbage: true }),
      () => ok(FEED_A),
    ];
    let i = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return responses[i++]!();
    }) as unknown as typeof fetch;
    const load = () => useCommandsStore.getState().load({ force: true });
    await load();
    expect(useCommandsStore.getState().commands).toHaveLength(4);
    await load();
    expect(useCommandsStore.getState().commands).toHaveLength(4);
    await load();
    expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
      "init",
      "officecli",
    ]);
    await load();
    expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
      "init",
      "officecli",
    ]);
    await load();
    expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
      "init",
      "officecli",
    ]);
    await load();
    expect(useCommandsStore.getState().commands).toHaveLength(4);
    // The cache is never observed empty once populated.
    expect(useCommandsStore.getState().commands.length).toBeGreaterThan(0);
  });
});
