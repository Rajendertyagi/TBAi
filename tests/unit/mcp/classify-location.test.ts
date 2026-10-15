/**
 * `classifyLocation` (Phase 2 — local/remote classification) — pure unit level.
 *
 * Classifies a configured MCP server as "local" (spawns a process on this
 * machine, or is addressed at a loopback host) or "remote". The rule under
 * test:
 *
 *   - STDIO transport → always local (the server process is spawned here).
 *   - HTTP/SSE transport → local iff the URL host is localhost, a valid
 *     loopback address (127.0.0.0/8 or IPv6 loopback), or a *.localhost
 *     name; anything else — a missing URL, a malformed URL, or a
 *     non-loopback host — is remote.
 *
 * The bare-unbracketed `::1` case is load-bearing: `new URL("http://::1:3000")`
 * throws, so an unbracketed IPv6 host is an INVALID url, not a loopback one,
 * and the function must classify it "remote".
 *
 * No I/O, no connections: the subject is a pure function over the config.
 */
import { describe, it, expect } from "bun:test";
import { classifyLocation } from "@/services/mcp/transport.ts";
import type { McpServerConfig } from "@/services/mcp/types.ts";

function config(
  partial: Partial<McpServerConfig> & { transport: McpServerConfig["transport"] },
): McpServerConfig {
  return {
    id: "srv-1",
    name: "fixture",
    authType: "none",
    enabled: true,
    autoConnect: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("classifyLocation — stdio transport", () => {
  it("is always local, regardless of any other field", () => {
    expect(classifyLocation(config({ transport: "stdio", command: "npx" }))).toBe("local");
    // Even a stdio config that carries a URL: the transport wins.
    expect(
      classifyLocation(
        config({ transport: "stdio", command: "npx", url: "https://api.example.com" }),
      ),
    ).toBe("local");
  });
});

describe("classifyLocation — http transport, loopback hosts", () => {
  it("classifies localhost as local", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://localhost:3000" }))).toBe(
      "local",
    );
  });

  it("classifies 127.0.0.1 as local", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://127.0.0.1:3000" }))).toBe(
      "local",
    );
  });

  it("classifies 127.0.0.2 as local (127.0.0.0/8 range)", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://127.0.0.2:3000" }))).toBe(
      "local",
    );
  });

  it("classifies 127.1.2.3 as local (127.0.0.0/8 range)", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://127.1.2.3:3000" }))).toBe(
      "local",
    );
  });

  it("classifies the bracketed IPv6 loopback [::1] as local", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://[::1]:3000" }))).toBe("local");
    // No explicit port: the hostname is still the loopback literal.
    expect(classifyLocation(config({ transport: "http", url: "http://[::1]/mcp" }))).toBe("local");
  });

  it("accepts both bracketed and bare IPv6 loopback spellings", () => {
    // Bun's URL.hostname keeps the brackets ("[::1]"), but the bare form is
    // accepted too so the rule does not depend on one runtime's spelling.
    expect(classifyLocation(config({ transport: "http", url: "http://[::1]:3000" }))).toBe("local");
  });

  it("classifies *.localhost as local", () => {
    expect(
      classifyLocation(config({ transport: "http", url: "http://myhost.localhost:3000" })),
    ).toBe("local");
    expect(
      classifyLocation(config({ transport: "http", url: "http://deep.sub.localhost:3000" })),
    ).toBe("local");
  });

  it("is case-insensitive on the host", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://LOCALHOST:3000" }))).toBe(
      "local",
    );
    expect(
      classifyLocation(config({ transport: "http", url: "http://MyHost.LocalHost:3000" })),
    ).toBe("local");
  });

  it("classifies an unbracketed bare ::1 as remote (it is not a valid URL host)", () => {
    // new URL("http://::1:3000") throws; the catch path reports remote.
    expect(classifyLocation(config({ transport: "http", url: "http://::1:3000" }))).toBe("remote");
  });
});

describe("classifyLocation — http transport, remote hosts", () => {
  it("classifies a non-loopback host as remote", () => {
    expect(classifyLocation(config({ transport: "http", url: "http://api.example.com" }))).toBe(
      "remote",
    );
    expect(
      classifyLocation(config({ transport: "http", url: "https://api.example.com:8443/mcp" })),
    ).toBe("remote");
  });

  it("classifies a numeric-looking hostname as remote (not a valid IP)", () => {
    expect(
      classifyLocation(
        config({ transport: "http", url: "http://127.0.0.1.evil.example.com:3000" }),
      ),
    ).toBe("remote");
  });

  it("classifies a missing URL as remote (not a loopback by default)", () => {
    expect(classifyLocation(config({ transport: "http" }))).toBe("remote");
  });

  it("classifies a malformed URL string as remote", () => {
    expect(classifyLocation(config({ transport: "http", url: "not a url" }))).toBe("remote");
  });
});

describe("classifyLocation — sse transport", () => {
  it("classifies a loopback host as local", () => {
    expect(classifyLocation(config({ transport: "sse", url: "http://localhost:3000/sse" }))).toBe(
      "local",
    );
  });

  it("classifies a remote host as remote", () => {
    expect(classifyLocation(config({ transport: "sse", url: "http://api.example.com/sse" }))).toBe(
      "remote",
    );
  });
});
