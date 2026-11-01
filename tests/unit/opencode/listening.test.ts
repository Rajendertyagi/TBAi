/**
 * The managed child's listening announcement (Priority A).
 *
 * `opencode serve --port 0 --hostname 127.0.0.1` binds a kernel-assigned port
 * and prints `server listening on http://127.0.0.1:<port>`. The manager uses
 * that address and nothing else, so these tests pin the refusals as hard as the
 * acceptance: a wrong host, an external address, a missing or unusable port, a
 * conflicting pair of announcements, and output that ends without one.
 */
import { describe, expect, it } from "bun:test";

import { OPENCODE_CONFIG, type OpenCodeConfig } from "@/config/opencode.ts";
import {
  createOpenCodeListeningDiscovery,
  OpenCodeListeningConflictError,
  OpenCodeListeningMissingError,
  OpenCodeListeningUrlError,
  parseListeningAnnouncement,
  redactServerAnnouncementLine,
  splitCompleteLines,
  stripAnsi,
  validateListeningUrl,
} from "@/services/opencode/listening.ts";

const ANNOUNCEMENT = "server listening on http://127.0.0.1:4096";

describe("validateListeningUrl", () => {
  it("accepts the canonical loopback announcement", () => {
    expect(validateListeningUrl("http://127.0.0.1:4096")).toEqual({
      baseUrl: "http://127.0.0.1:4096",
      port: 4096,
    });
  });

  it("accepts a trailing root slash and ANSI decoration", () => {
    expect(validateListeningUrl("http://127.0.0.1:4096/").port).toBe(4096);
    expect(validateListeningUrl("\u001b[32mhttp://127.0.0.1:4096\u001b[0m").port).toBe(4096);
  });

  it("keeps an explicit port 80 distinct from an omitted one", () => {
    // `new URL` reports an empty port for the default port; the authority is
    // parsed directly so "port 80" cannot masquerade as "no port".
    expect(validateListeningUrl("http://127.0.0.1:80").baseUrl).toBe("http://127.0.0.1:80");
    expect(() => validateListeningUrl("http://127.0.0.1")).toThrow(OpenCodeListeningUrlError);
  });

  it.each([
    ["not-a-url", "malformed"],
    ["127.0.0.1:4096", "malformed"],
    ["https://127.0.0.1:4096", "protocol"],
    ["http://user:pass@127.0.0.1:4096", "userinfo"],
    ["http://0.0.0.0:4096", "hostname"],
    ["http://localhost:4096", "hostname"],
    ["http://[::1]:4096", "hostname"],
    ["http://192.168.1.5:4096", "hostname"],
    ["http://10.0.0.7:4096", "hostname"],
    ["http://127.0.0.1", "port"],
    ["http://127.0.0.1:0", "port"],
    ["http://127.0.0.1:65536", "port"],
    ["http://127.0.0.1:abc", "port"],
    ["http://127.0.0.1:/", "port"],
    ["http://127.0.0.1:4096/api", "path"],
    ["http://127.0.0.1:4096?x=1", "path"],
    ["http://127.0.0.1:4096#frag", "path"],
  ] as const)("refuses %p as %p", (token, reason) => {
    try {
      validateListeningUrl(token);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeListeningUrlError);
      expect((error as OpenCodeListeningUrlError).reason).toBe(reason);
    }
  });

  it("never echoes the offending address in the refusal", () => {
    try {
      validateListeningUrl("http://evil.example.com:4096");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeListeningUrlError);
      expect((error as Error).message).not.toContain("evil.example.com");
    }
  });

  it("accepts the configured hostname instead of a hardcoded one", () => {
    const config: OpenCodeConfig = { ...OPENCODE_CONFIG, managedBindHostname: "127.0.0.2" };
    expect(validateListeningUrl("http://127.0.0.2:8080", config).port).toBe(8080);
    expect(() => validateListeningUrl("http://127.0.0.1:8080", config)).toThrow(
      OpenCodeListeningUrlError,
    );
  });
});

describe("parseListeningAnnouncement", () => {
  it("extracts the URL from the real announcement line", () => {
    expect(parseListeningAnnouncement(ANNOUNCEMENT)).toEqual({
      baseUrl: "http://127.0.0.1:4096",
      port: 4096,
    });
  });

  it("tolerates log decoration before and after the announcement", () => {
    expect(
      parseListeningAnnouncement(
        "INFO  2026-10-31 server listening on http://127.0.0.1:5000 (ready)",
      )?.port,
    ).toBe(5000);
  });

  it("is case-insensitive and ANSI-aware", () => {
    expect(
      parseListeningAnnouncement("\u001b[36mSERVER LISTENING ON http://127.0.0.1:7777\u001b[0m")
        ?.port,
    ).toBe(7777);
  });

  it("returns null for a line that is not an announcement", () => {
    expect(parseListeningAnnouncement("booting opencode")).toBeNull();
    expect(parseListeningAnnouncement("")).toBeNull();
  });

  it("refuses an announcement marker with no usable URL", () => {
    expect(() => parseListeningAnnouncement("server listening on")).toThrow(
      OpenCodeListeningUrlError,
    );
    expect(() => parseListeningAnnouncement("server listening on https://127.0.0.1:1")).toThrow(
      OpenCodeListeningUrlError,
    );
  });
});

describe("splitCompleteLines", () => {
  it("returns complete lines and the unterminated rest", () => {
    expect(splitCompleteLines("a\nb\nc")).toEqual({ lines: ["a", "b"], rest: "c" });
  });

  it("strips a trailing carriage return", () => {
    expect(splitCompleteLines("a\r\n").lines).toEqual(["a"]);
  });
});

describe("stripAnsi and password redaction", () => {
  it("removes SGR sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  it("redacts a server-generated password but keeps the line", () => {
    const redacted = redactServerAnnouncementLine("server password tbai-super-secret");
    expect(redacted).toBe("server password [redacted]");
    expect(redacted).not.toContain("tbai-super-secret");
  });

  it("leaves an ordinary line untouched", () => {
    expect(redactServerAnnouncementLine(ANNOUNCEMENT)).toBe(ANNOUNCEMENT);
  });
});

/** Resolves once the discovery has had a chance to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createOpenCodeListeningDiscovery", () => {
  it("resolves from one complete announcement", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push(`${ANNOUNCEMENT}\n`);
    await expect(discovery.promise).resolves.toEqual({
      baseUrl: "http://127.0.0.1:4096",
      port: 4096,
    });
  });

  it("resolves when a chunk splits the line and the URL", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push("boot: starting\nserver lis");
    discovery.push("tening on http://127.0.0.");
    discovery.push("1:4096\n");
    await expect(discovery.promise).resolves.toMatchObject({ port: 4096 });
  });

  it("ignores lines before and after the announcement", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push("booting\n");
    discovery.push(`${ANNOUNCEMENT}\nserving requests\n`);
    await expect(discovery.promise).resolves.toMatchObject({ port: 4096 });
  });

  it("accepts the same address announced twice", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push(`${ANNOUNCEMENT}\n`);
    discovery.push(`${ANNOUNCEMENT}\n`);
    await expect(discovery.promise).resolves.toMatchObject({ port: 4096 });
  });

  it("refuses two different addresses in one read before accepting either", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push(
      "server listening on http://127.0.0.1:4000\nserver listening on http://127.0.0.1:5000\n",
    );
    await expect(discovery.promise).rejects.toBeInstanceOf(OpenCodeListeningConflictError);
  });

  it("keeps the first address once delivered and ignores a later one", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push("server listening on http://127.0.0.1:4000\n");
    const target = await discovery.promise;
    discovery.push("server listening on http://127.0.0.1:5000\n");
    await flush();
    expect(target.port).toBe(4000);
  });

  it("refuses an unusable announcement and names the rule", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push("server listening on http://0.0.0.0:4096\n");
    try {
      await discovery.promise;
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeListeningUrlError);
      expect((error as OpenCodeListeningUrlError).reason).toBe("hostname");
    }
  });

  it("fails when the output ends with no announcement", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push("boot: starting\n");
    discovery.end();
    await expect(discovery.promise).rejects.toBeInstanceOf(OpenCodeListeningMissingError);
  });

  it("flushes an unterminated announcement at end of output", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push(ANNOUNCEMENT);
    discovery.end();
    await expect(discovery.promise).resolves.toMatchObject({ port: 4096 });
  });

  it("drops an over-long complete line instead of matching inside it", async () => {
    const config: OpenCodeConfig = { ...OPENCODE_CONFIG, listeningLineMaxBytes: 64 };
    const discovery = createOpenCodeListeningDiscovery(config);
    discovery.push(`${"x".repeat(200)} ${ANNOUNCEMENT}\n`);
    discovery.push(`${ANNOUNCEMENT}\n`);
    await expect(discovery.promise).resolves.toMatchObject({ port: 4096 });
  });

  it("discards an over-long unterminated line up to its newline", async () => {
    const config: OpenCodeConfig = { ...OPENCODE_CONFIG, listeningLineMaxBytes: 64 };
    const discovery = createOpenCodeListeningDiscovery(config);
    discovery.push("y".repeat(200));
    discovery.push(` tail-of-that-line\n${ANNOUNCEMENT}\n`);
    await expect(discovery.promise).resolves.toMatchObject({ port: 4096 });
  });

  it("ignores a push after it has settled", async () => {
    const discovery = createOpenCodeListeningDiscovery();
    discovery.push(`${ANNOUNCEMENT}\n`);
    await discovery.promise;
    expect(() => discovery.push("server listening on http://127.0.0.1:1\n")).not.toThrow();
    discovery.end();
  });
});
