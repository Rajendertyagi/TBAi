import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  OpenCodeConfigUnreadableError,
  selectConfigDocument,
  serializeOpenCodeConfig,
  setOpenCodeConfigValue,
  setOpenCodePermissionEffect,
  readOpenCodeConfigDocument,
  writeOpenCodeConfigDocument,
} from "./configDocument";

/**
 * The real configuration document, as the live managed server reported it.
 *
 * This is the fixture every preservation test runs against, and it is a COPY of
 * the user's actual file — including the four `deny` rules that protect
 * RULES.md, opencode.json and the plugin directory, and including provider
 * credentials this module must never touch.
 */
const REAL_CONFIG = JSON.stringify(
  {
    $schema: "https://opencode.ai/config.json",
    shell: "powershell",
    permissions: [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "edit", resource: "**/config/RULES.md", effect: "deny" },
      { action: "edit", resource: "**/config/opencode.json", effect: "deny" },
      { action: "edit", resource: "**/config/opencode/plugins/*.ts", effect: "deny" },
      { action: "edit", resource: ".config/opencode/opencode.json", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "ask" },
      { action: "subagent", resource: "*", effect: "ask" },
    ],
    providers: {
      openrouter: {
        name: "OpenRouter",
        package: "aisdk:@ai-sdk/openai",
        settings: { apiKey: "sk-or-secret", baseURL: "https://openrouter.ai/api/v1" },
      },
    },
  },
  null,
  2,
);

const PROTECTED = [
  ["edit", "**/config/RULES.md"],
  ["edit", "**/config/opencode.json"],
  ["edit", "**/config/opencode/plugins/*.ts"],
  ["edit", ".config/opencode/opencode.json"],
] as const;

function rulesOf(text: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(text) as { permissions: Array<Record<string, unknown>> };
  return parsed.permissions;
}

describe("selectConfigDocument", () => {
  it("picks the document carrying permissions, not the TBAi-owned one", () => {
    // Exactly the four entries the live server returned, in its order. The
    // fourth parses fine and is TBAi's own file — a path-based rule would pick
    // it and edit a file OpenCode never reads for permissions.
    const selected = selectConfigDocument([
      {
        type: "document",
        path: "D:\\IT\\Coding\\OpenCode\\.config\\opencode\\opencode.json",
        info: { permissions: [{ action: "question", resource: "*", effect: "ask" }] },
      },
      { type: "directory", path: "D:\\IT\\Coding\\OpenCode\\.config\\opencode" },
      { type: "document", path: "D:\\Temp\\openchamber\\.chamber-data\\opencode.managed.json", info: { plugins: [] } },
      { type: "document", path: "D:\\Temp\\ai-chat-app\\data\\opencode-home\\opencode.json", info: { model: "agnes/agnes-2.5-flash" } },
    ]);
    expect(selected?.path).toBe("D:\\IT\\Coding\\OpenCode\\.config\\opencode\\opencode.json");
  });

  it("falls back to the first document when none carries permissions", () => {
    const selected = selectConfigDocument([
      { type: "document", path: "/a/opencode.json", info: { model: "x/y" } },
      { type: "document", path: "/b/opencode.json", info: {} },
    ]);
    expect(selected?.path).toBe("/a/opencode.json");
  });

  it("ignores directory entries when no document qualifies", () => {
    expect(selectConfigDocument([{ type: "directory", path: "/only/dir" }])).toBeNull();
  });
});

describe("setOpenCodePermissionEffect", () => {
  it("changes the question rule from ask to allow", () => {
    const next = setOpenCodePermissionEffect(
      JSON.parse(REAL_CONFIG).permissions,
      { action: "question", resource: "*" },
      "allow",
    ) as Array<Record<string, unknown>>;
    const question = next.find((r) => r.action === "question");
    expect(question?.effect).toBe("allow");
  });

  it("preserves every protected deny rule", () => {
    const next = setOpenCodePermissionEffect(
      JSON.parse(REAL_CONFIG).permissions,
      { action: "question", resource: "*" },
      "allow",
    ) as Array<Record<string, unknown>>;
    for (const [action, resource] of PROTECTED) {
      const rule = next.find((r) => r.action === action && r.resource === resource);
      expect(rule).toBeDefined();
      expect(rule?.effect).toBe("deny");
    }
  });

  it("preserves the position of the edited rule", () => {
    const before = rulesOf(REAL_CONFIG);
    const next = setOpenCodePermissionEffect(
      before,
      { action: "question", resource: "*" },
      "allow",
    ) as Array<Record<string, unknown>>;
    expect(next).toHaveLength(before.length);
    next.forEach((rule, index) => {
      expect(rule.action).toBe(before[index].action);
      expect(rule.resource).toBe(before[index].resource);
    });
  });

  it("leaves the input array untouched (no mutation)", () => {
    const before = JSON.parse(REAL_CONFIG).permissions as Array<Record<string, unknown>>;
    const snapshot = JSON.stringify(before);
    setOpenCodePermissionEffect(before, { action: "question", resource: "*" }, "allow");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("returns the same array when the rule is absent, inventing nothing", () => {
    const before = JSON.parse(REAL_CONFIG).permissions;
    expect(
      setOpenCodePermissionEffect(before, { action: "todowrite", resource: "*" }, "deny"),
    ).toBe(before);
  });

  it("matches on action AND resource, so a shared pattern is not touched", () => {
    // Every rule here uses resource "*". Changing `question` must not touch
    // `shell`, which shares that exact pattern.
    const before = JSON.parse(REAL_CONFIG).permissions;
    const next = setOpenCodePermissionEffect(
      before,
      { action: "question", resource: "*" },
      "allow",
    ) as Array<Record<string, unknown>>;
    expect(next.find((r) => r.action === "shell")?.effect).toBe("ask");
  });

  it("keeps an unknown extra field on the edited rule", () => {
    const current = [
      { action: "question", resource: "*", effect: "ask", futureField: 42 },
    ];
    const next = setOpenCodePermissionEffect(
      current,
      { action: "question", resource: "*" },
      "allow",
    ) as Array<Record<string, unknown>>;
    expect(next[0].futureField).toBe(42);
  });

  it("refuses a permissions value that is not an array", () => {
    expect(() =>
      setOpenCodePermissionEffect({ question: "ask" }, { action: "question", resource: "*" }, "allow"),
    ).toThrow(OpenCodeConfigUnreadableError);
  });
});

describe("setOpenCodeConfigValue", () => {
  it("preserves provider credentials and every other top-level key", () => {
    const next = setOpenCodeConfigValue(
      REAL_CONFIG,
      "permissions",
      setOpenCodePermissionEffect(
        JSON.parse(REAL_CONFIG).permissions,
        { action: "question", resource: "*" },
        "allow",
      ),
    );
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(parsed.shell).toBe("powershell");
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    const providers = parsed.providers as Record<string, { settings: { apiKey: string } }>;
    expect(providers.openrouter.settings.apiKey).toBe("sk-or-secret");
  });

  it("preserves the protected deny rules through a full round trip", () => {
    const next = setOpenCodeConfigValue(
      REAL_CONFIG,
      "permissions",
      setOpenCodePermissionEffect(
        JSON.parse(REAL_CONFIG).permissions,
        { action: "question", resource: "*" },
        "allow",
      ),
    );
    for (const [action, resource] of PROTECTED) {
      const rule = rulesOf(next).find(
        (r) => r.action === action && r.resource === resource,
      );
      expect(rule?.effect).toBe("deny");
    }
  });

  it("preserves an unknown future top-level field", () => {
    const withFuture = JSON.stringify({
      permissions: [],
      someFutureOpenCodeField: { nested: true },
    });
    const next = setOpenCodeConfigValue(withFuture, "permissions", [
      { action: "question", resource: "*", effect: "allow" },
    ]);
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(parsed.someFutureOpenCodeField).toEqual({ nested: true });
  });

  it("deletes a key when the value is undefined", () => {
    const next = setOpenCodeConfigValue(REAL_CONFIG, "shell", undefined);
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect("shell" in parsed).toBe(false);
    expect(parsed.permissions).toBeDefined();
  });

  it("refuses to write malformed JSON", () => {
    expect(() => setOpenCodeConfigValue("{ not json", "permissions", [])).toThrow(
      OpenCodeConfigUnreadableError,
    );
  });

  it("refuses a JSON array document", () => {
    expect(() => setOpenCodeConfigValue("[]", "permissions", [])).toThrow(
      OpenCodeConfigUnreadableError,
    );
  });

  it("treats an absent file as an empty base for a first write", () => {
    const next = setOpenCodeConfigValue("", "permissions", [
      { action: "question", resource: "*", effect: "allow" },
    ]);
    expect(rulesOf(next)).toHaveLength(1);
  });

  it("ends with a trailing newline", () => {
    expect(serializeOpenCodeConfig({ a: 1 }).endsWith("\n")).toBe(true);
  });
});

describe("writeOpenCodeConfigDocument", () => {
  const current = { permissions: [{ action: "question", resource: "*", effect: "ask" }] };

  it("refuses an empty document", async () => {
    await expect(
      writeOpenCodeConfigDocument("unused", "   ", current),
    ).rejects.toThrow(OpenCodeConfigUnreadableError);
  });

  it("refuses a write that would drop the permissions array", async () => {
    const withoutPermissions = JSON.stringify({ shell: "powershell" }, null, 2);
    await expect(
      writeOpenCodeConfigDocument("unused", withoutPermissions, current),
    ).rejects.toThrow(/permissions would no longer be a rule array/);
  });

  it("refuses when the current permissions value is not an array", async () => {
    // The object form reaches the second guard instead of the first: the
    // candidate still holds an object at `permissions`, so the message names
    // the current value rather than the candidate. Either refusal is correct;
    // what matters is that no write happens.
    const next = JSON.stringify({ permissions: { question: "ask" } }, null, 2);
    await expect(
      writeOpenCodeConfigDocument("unused", next, { permissions: { question: "ask" } }),
    ).rejects.toThrow(OpenCodeConfigUnreadableError);
  });

  it("refuses when a candidate would replace a non-array permissions with an array", async () => {
    // The inverse: the current value is an object, so normalising it to an
    // array would be an invented migration rather than an edit.
    const next = JSON.stringify({ permissions: [] }, null, 2);
    await expect(
      writeOpenCodeConfigDocument("unused", next, { permissions: { question: "ask" } }),
    ).rejects.toThrow(OpenCodeConfigUnreadableError);
  });

  it("accepts a valid write against a real temp file", async () => {
    const path = `${Bun.env.TEMP ?? "."}/tbai-cfg-${Date.now()}.json`;
    await Bun.write(path, REAL_CONFIG);
    try {
      const next = setOpenCodeConfigValue(
        REAL_CONFIG,
        "permissions",
        setOpenCodePermissionEffect(
          JSON.parse(REAL_CONFIG).permissions,
          { action: "question", resource: "*" },
          "allow",
        ),
      );
      await writeOpenCodeConfigDocument(path, next, JSON.parse(REAL_CONFIG));
      const written = JSON.parse(await Bun.file(path).text()) as {
        permissions: Array<Record<string, unknown>>;
        providers: unknown;
      };
      expect(written.permissions.find((r) => r.action === "question")?.effect).toBe("allow");
      for (const [action, resource] of PROTECTED) {
        expect(
          written.permissions.find((r) => r.action === action && r.resource === resource)?.effect,
        ).toBe("deny");
      }
      expect(written.providers).toBeDefined();
    } finally {
      await Bun.file(path).delete();
    }
  });
});

describe("readOpenCodeConfigDocument", () => {
  /** Minimal stand-in for the managed server's `GET /api/config`. */
  function stubServer(payload: unknown, ok = true) {
    return (input: string | URL | Request) => {
      void input;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
  }

  it("reports a malformed file as malformed rather than parsing past it", async () => {
    const original = globalThis.fetch;
    const path = `${Bun.env.TEMP ?? "."}/tbai-bad-${Date.now()}.json`;
    await Bun.write(path, "{ this is not json");
    globalThis.fetch = stubServer([
      {
        type: "document",
        path,
        info: { permissions: [{ action: "question", resource: "*", effect: "ask" }] },
      },
    ]) as typeof fetch;
    try {
      const doc = await readOpenCodeConfigDocument("http://127.0.0.1:1", {});
      expect(doc.malformed).toBe(true);
    } finally {
      globalThis.fetch = original;
      await Bun.file(path).delete();
    }
  });

  it("throws a typed error when the server answers non-200", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = stubServer({}, false) as typeof fetch;
    try {
      await expect(readOpenCodeConfigDocument("http://127.0.0.1:1", {})).rejects.toThrow(
        OpenCodeConfigUnreadableError,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports the broken global config instead of falling through to another file", async () => {
    // The live bug this guards. A global config the server cannot parse is
    // DROPPED from its own listing, so selection fell through to a different,
    // healthy file and reported `editable: true` with 0 rules for a document
    // that is not the policy — while the file actually breaking OpenCode went
    // unmentioned. The `directory` entry is the only place the real path is
    // knowable, because it is XDG-resolved on the host.
    const original = globalThis.fetch;
    const dir = `${Bun.env.TEMP ?? "."}/tbai-cfgdir-${Date.now()}`;
    await Bun.write(`${dir}/opencode.json`, "{ malformed probe");
    const healthy = `${Bun.env.TEMP ?? "."}/tbai-healthy-${Date.now()}.json`;
    await Bun.write(healthy, JSON.stringify({ plugins: ["-opencode.browser"] }, null, 2));
    globalThis.fetch = stubServer([
      // Exactly what the live server returned with the global config broken.
      { type: "directory", path: dir },
      { type: "document", path: healthy, info: { plugins: ["-opencode.browser"] } },
    ]) as typeof fetch;
    try {
      const doc = await readOpenCodeConfigDocument("http://127.0.0.1:1", {});
      expect(doc.malformed).toBe(true);
      // Compared against a host-normalized path, because the reported path uses
      // the platform separator (it sits beside the server's own paths in the UI).
      expect(doc.path).toBe(join(dir, "opencode.json"));
      expect(doc.path).not.toBe(healthy);
    } finally {
      globalThis.fetch = original;
      await Bun.file(join(dir, "opencode.json")).delete();
      await Bun.file(healthy).delete();
    }
  });

  it("reports a JSONC global config as malformed rather than rewriting it", async () => {
    // OpenCode accepts JSONC, and `JSON.parse` does not. Editing such a file
    // with a JSON serializer would delete the user's comments on the first
    // save, so it is reported read-only instead.
    const original = globalThis.fetch;
    const dir = `${Bun.env.TEMP ?? "."}/tbai-jsonc-${Date.now()}`;
    await Bun.write(`${dir}/opencode.jsonc`, '{\n  // keep me\n  "shell": "powershell"\n}');
    globalThis.fetch = stubServer([{ type: "directory", path: dir }]) as typeof fetch;
    try {
      const doc = await readOpenCodeConfigDocument("http://127.0.0.1:1", {});
      expect(doc.malformed).toBe(true);
      expect(doc.raw).toContain("keep me");
    } finally {
      globalThis.fetch = original;
      await Bun.file(`${dir}/opencode.jsonc`).delete();
    }
  });

  it("does not treat a healthy global config as malformed", async () => {
    // The guard above must not fire on a good file, or the page would be
    // permanently read-only for a correct configuration.
    const original = globalThis.fetch;
    const dir = `${Bun.env.TEMP ?? "."}/tbai-good-${Date.now()}`;
    const good = `${dir}/opencode.json`;
    await Bun.write(good, JSON.stringify({ permissions: [] }, null, 2));
    globalThis.fetch = stubServer([
      { type: "directory", path: dir },
      {
        type: "document",
        path: good,
        info: { permissions: [] },
      },
    ]) as typeof fetch;
    try {
      const doc = await readOpenCodeConfigDocument("http://127.0.0.1:1", {});
      expect(doc.malformed).toBe(false);
      expect(doc.path).toBe(good);
    } finally {
      globalThis.fetch = original;
      await Bun.file(good).delete();
    }
  });

  it("still selects a healthy later document when the first has no permissions key", async () => {
    // The guard above must not turn "no permissions key" into "malformed": an
    // absent key is a legitimate document, and the later document carrying the
    // rules is still the right thing to edit.
    const original = globalThis.fetch;
    const first = `${Bun.env.TEMP ?? "."}/tbai-first-${Date.now()}.json`;
    const second = `${Bun.env.TEMP ?? "."}/tbai-second-${Date.now()}.json`;
    await Bun.write(first, JSON.stringify({ shell: "powershell" }, null, 2));
    await Bun.write(
      second,
      JSON.stringify({ permissions: [{ action: "question", resource: "*", effect: "ask" }] }, null, 2),
    );
    globalThis.fetch = stubServer([
      { type: "document", path: first, info: { shell: "powershell" } },
      {
        type: "document",
        path: second,
        info: { permissions: [{ action: "question", resource: "*", effect: "ask" }] },
      },
    ]) as typeof fetch;
    try {
      const doc = await readOpenCodeConfigDocument("http://127.0.0.1:1", {});
      expect(doc.malformed).toBe(false);
      expect(doc.path).toBe(second);
    } finally {
      globalThis.fetch = original;
      await Bun.file(first).delete();
      await Bun.file(second).delete();
    }
  });
});
