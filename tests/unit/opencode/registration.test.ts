import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import { REPO_ROOT } from "../../helpers/repo-root";
import { stripComments } from "../../helpers/web/source-scope";
import {
  OpenCodeRegistrationRefusalError,
  readOpenCodeRegistration,
  registrationFilenameForChannel,
  resolveRegistrationPath,
  type OpenCodeRegistrationReadOptions,
  type OpenCodeRegistrationRefusalCode,
  type RegistrationFileOpener,
  type RegistrationReadHandle,
} from "@/services/opencode/registration.ts";

/**
 * BT1–BT16 — the registration read (§2.2–§2.8).
 *
 * Every case runs against a disposable directory created for that case; no
 * case reads the real user's state directory, registration file or password.
 * The `openFile` seam is the reader's test-only surface: it makes the
 * lstat-versus-fstat swap, the actual-byte cap and the handle-only parse
 * deterministic without patching `node:fs` for the whole process.
 *
 * BT10 runs a real directory reparse point (junction on Windows, directory
 * symlink elsewhere), which needs no elevation. A FILE symlink is the case this
 * host cannot construct: it requires SeCreateSymbolicLinkPrivilege or Windows
 * Developer Mode, and the measured result here is EPERM. That case is named
 * BLOCKED with the exact missing prerequisite instead of being skipped
 * silently.
 *
 * BT11's writer sequence was verified against the pinned upstream source on
 * 2026-10-31: tag `v2.2.0` of `anomalyco/opencode`, file
 * `packages/cli/src/services/service-config.ts`
 * (sha256 19856f97f41d8a081bb57d3e1bb6c1a5e801037b5964e5dde0418240b9c63c52),
 * whose `write()` builds `<configFile>.<pid>.tmp`, writes with mode `0o600`
 * and declares a 20-attempt/10 ms rename retry (lines 183-189); the
 * registration writer declares the same retry around `<file>.<id>.tmp`. That
 * source is not vendored here, so this file asserts TBAi's own side: the
 * reader never opens for writing and never renames or rewrites the record.
 *
 * The shipped binaries were then run separately in disposable isolated roots
 * (official npm artifacts, synthetic credentials, no owner data). Runtime
 * observations, kept distinct from the source claims above:
 * - 2.2.0 temp names match the source exactly: config
 *   `<configFile>.<pid>.tmp`, registration `<file>.<registration id>.tmp`.
 * - The rename retry is real and ~200 ms wide. With the destination held open
 *   without FILE_SHARE_DELETE and released d ms after the temp appeared, the
 *   2.2.0 writer landed a valid registration 10-30 ms after release for every
 *   d <= 200 ms, and for no d >= 240 ms, where it exited code 1 with
 *   `EPERM`/`PlatformError` 257-281 ms after writing the temp and left it
 *   behind. That boundary matches the declared 20 attempts spaced 10 ms. The
 *   config writer behaved the same (600 ms hold -> exit 1 at ~260 ms).
 * - 2.0.15 retries not at all: it exits code 1 about 20 ms after the temp
 *   regardless of the hold, leaves the temp, and its config temp is
 *   `<file>.tmp`.
 * - A tight read loop through `fs.open(path, "r")` (1,206 opens in 4 s, the
 *   same libuv share mode the reader uses) never disturbed the 2.2.0 writer:
 *   the service stayed up and the record's `pid` matched.
 * All five captured records (2.0.15, 2.1.0, 2.1.4, and two 2.2.0 runs) were
 * accepted by `readOpenCodeRegistration`, including the ignored `id`.
 */

const ORIGIN = "http://127.0.0.1:4107";
const OTHER_ORIGIN = "http://127.0.0.1:4108";
const PASSWORD = "registration-fixture-password";
const PID = 4242;
const VERSION = "2.2.0";

const MAX_BYTES = OPENCODE_CONFIG.registrationFileMaxBytes;

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tbai-opencode-registration-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { url: ORIGIN, pid: PID, password: PASSWORD, version: VERSION, ...overrides };
}

function writeFile(name: string, content: string): string {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function writeRecord(name: string, value: unknown = record()): string {
  return writeFile(name, JSON.stringify(value));
}

/** Runs a read expected to refuse and returns the typed refusal. */
async function refusalOf(promise: Promise<unknown>): Promise<OpenCodeRegistrationRefusalError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenCodeRegistrationRefusalError) return error;
    throw error;
  }
  throw new Error("expected a registration refusal, but the read resolved");
}

function read(file: string, extra: Partial<OpenCodeRegistrationReadOptions> = {}) {
  return readOpenCodeRegistration({ path: file, ...extra });
}

/** An in-memory handle, so the reader's parse can be shown to use its bytes. */
function memoryHandle(bytes: Uint8Array): {
  handle: RegistrationReadHandle;
  closes: () => number;
} {
  let closes = 0;
  return {
    handle: {
      stat: async () => ({ isFile: () => true }),
      read: async (buffer, offset, length, position) => {
        const slice = bytes.subarray(position, position + length);
        buffer.set(slice, offset);
        return { bytesRead: slice.length };
      },
      close: async () => {
        closes += 1;
      },
    },
    closes: () => closes,
  };
}

describe("BT1 — fallback path resolution", () => {
  it("uses XDG_STATE_HOME when set", () => {
    const state = path.join(root, "xdg-state");
    const resolved = resolveRegistrationPath({
      env: { XDG_STATE_HOME: state },
      homeDir: path.join(root, "home"),
    });
    expect(resolved).toBe(path.join(state, "opencode", "service.json"));
  });

  it("falls back to <home>/.local/state when the variable is unset", () => {
    const home = path.join(root, "home");
    const resolved = resolveRegistrationPath({ env: {}, homeDir: home });
    expect(resolved).toBe(path.join(home, ".local", "state", "opencode", "service.json"));
  });

  it("reads the resolved path and searches no second location", async () => {
    const home = path.join(root, "home");
    const fallback = path.join(home, ".local", "state", "opencode", "service.json");
    mkdirSync(path.dirname(fallback), { recursive: true });
    writeFileSync(fallback, JSON.stringify(record()));

    const found = await readOpenCodeRegistration({ env: {}, homeDir: home });
    expect(found.origin).toBe(ORIGIN);

    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const error = await refusalOf(
      readOpenCodeRegistration({ env: { XDG_STATE_HOME: elsewhere }, homeDir: home }),
    );
    expect(error.refusal).toBe("registration_missing");
  });
});

describe("BT2/BT3 — channel filename selection", () => {
  it("released channels share service.json", () => {
    for (const channel of ["latest", "beta", "next"]) {
      expect(registrationFilenameForChannel(channel)).toBe("service.json");
    }
    expect(registrationFilenameForChannel()).toBe("service.json");
  });

  it("other channels get a sanitized channel-specific filename", () => {
    expect(registrationFilenameForChannel("dev")).toBe("service-dev.json");
    expect(registrationFilenameForChannel("local")).toBe("service-local.json");
    expect(registrationFilenameForChannel("canary/edge")).toBe("service-canary-edge.json");
    expect(registrationFilenameForChannel("weird channel!")).toBe("service-weird-channel-.json");
  });
});

describe("BT5 — malformed JSON and wrong shape", () => {
  const cases: ReadonlyArray<readonly [string, string, OpenCodeRegistrationRefusalCode]> = [
    ["invalid JSON", "{not json", "registration_malformed"],
    ["empty file", "", "registration_malformed"],
    ["array", "[]", "registration_invalid_shape"],
    ["scalar", '"record"', "registration_invalid_shape"],
    ["null", "null", "registration_invalid_shape"],
    [
      "missing url",
      JSON.stringify({ pid: PID, password: PASSWORD, version: VERSION }),
      "registration_invalid_shape",
    ],
    ["non-numeric pid", JSON.stringify(record({ pid: "4242" })), "registration_invalid_pid"],
    ["zero pid", JSON.stringify(record({ pid: 0 })), "registration_invalid_pid"],
    ["fractional pid", JSON.stringify(record({ pid: 42.5 })), "registration_invalid_pid"],
  ];

  for (const [label, content, expected] of cases) {
    it(`refuses ${label}`, async () => {
      const file = writeFile(`case-${label.replaceAll(" ", "-")}.json`, content);
      const error = await refusalOf(read(file));
      expect(error.refusal).toBe(expected);
    });
  }
});

describe("BT6 — missing, empty and whitespace-only password", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["absent", { url: ORIGIN, pid: PID, version: VERSION }],
    ["empty", record({ password: "" })],
    ["whitespace-only", record({ password: "   " })],
  ];

  for (const [label, value] of cases) {
    it(`refuses a ${label} password as missing_credential`, async () => {
      const file = writeRecord(`password-${label}.json`, value);
      const error = await refusalOf(read(file));
      expect(error.refusal).toBe("missing_credential");
      expect(error.message).not.toContain(PASSWORD);
    });
  }
});

describe("BT8 — the version gate (B7: stable-only, no managed or evidence floor)", () => {
  const cases: ReadonlyArray<readonly [string, unknown, OpenCodeRegistrationRefusalCode]> = [
    ["absent version", undefined, "registration_unsupported_version"],
    ["non-version text", "latest", "registration_unsupported_version"],
    ["prerelease build", "2.2.0-beta.1", "registration_unsupported_version"],
  ];

  for (const [label, version, expected] of cases) {
    it(`refuses a record with ${label}`, async () => {
      const value =
        version === undefined ? { url: ORIGIN, pid: PID, password: PASSWORD } : record({ version });
      const file = writeRecord(`version-${label.replaceAll(" ", "-")}.json`, value);
      const error = await refusalOf(read(file));
      expect(error.refusal).toBe(expected);
    });
  }

  it("accepts a stable build below the evidence floor and leaves the decision to the live probe", async () => {
    // B7: `minimumVersion` is the oldest build TBAi has evidence for, not a
    // proven incompatible build. Refusing 2.0.14 here would re-impose a floor
    // the decision removed; `adoption.ts` probes its capabilities instead.
    const file = writeRecord("version-below-floor.json", record({ version: "2.0.14" }));
    const found = await read(file);
    expect(found.version).toBe("2.0.14");
  });

  it("accepts the audited stable version", async () => {
    const file = writeRecord("version-audited.json");
    const found = await read(file);
    expect(found.version).toBe(VERSION);
  });

  it("accepts a newer stable build and leaves the ceiling to the live probe", async () => {
    // B7: adoption is not restricted to the managed gate. The record is a hint,
    // so a stable build past `maximumVersionExclusive` is read here and judged
    // by `/api/info` plus the capability probes in `adoption.ts`.
    const file = writeRecord("version-newer.json", record({ version: "2.2.1" }));
    const found = await read(file);
    expect(found.version).toBe("2.2.1");
  });
});

describe("BT9 — URL validation", () => {
  const cases: ReadonlyArray<readonly [string, string, OpenCodeRegistrationRefusalCode]> = [
    ["non-loopback host", "http://10.0.0.5:4096", "registration_non_loopback"],
    ["remote localhost name", "http://opencode.internal:4096", "registration_non_loopback"],
    ["non-HTTP scheme", "ftp://127.0.0.1:4096", "registration_invalid_url"],
    ["relative url", "127.0.0.1:4096", "registration_invalid_url"],
    ["path", "http://127.0.0.1:4096/api", "registration_invalid_url"],
    ["query", "http://127.0.0.1:4096/?x=1", "registration_invalid_url"],
    ["fragment", "http://127.0.0.1:4096/#x", "registration_invalid_url"],
    ["userinfo", "http://user:secret@127.0.0.1:4096", "registration_invalid_url"],
  ];

  for (const [label, url, expected] of cases) {
    it(`refuses ${label} before any request`, async () => {
      const file = writeRecord(`url-${label.replaceAll(" ", "-")}.json`, record({ url }));
      const error = await refusalOf(read(file));
      expect(error.refusal).toBe(expected);
    });
  }

  it("accepts loopback IPv4, IPv6 and localhost over HTTP(S), canonicalized", async () => {
    for (const [url, origin] of [
      ["HTTP://127.0.0.1:4096/", "http://127.0.0.1:4096"],
      ["http://localhost:4096", "http://localhost:4096"],
      ["https://[::1]:4096", "https://[::1]:4096"],
    ] as const) {
      const file = writeRecord(
        `url-ok-${origin.replaceAll(/[^a-z0-9]/gi, "")}.json`,
        record({ url }),
      );
      const found = await read(file);
      expect(found.origin).toBe(origin);
    }
  });
});

/**
 * File-symlink capability probe. This host measured EPERM, so the file-symlink
 * case is BLOCKED rather than exercised; directory reparse points are covered
 * unconditionally below.
 */
const symlinkAvailable = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "tbai-symlink-probe-"));
  try {
    const target = path.join(probe, "target");
    writeFileSync(target, "x");
    symlinkSync(target, path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("BT10 — non-regular files", () => {
  it.skipIf(!symlinkAvailable)(
    "refuses a file symlink at lstat [BLOCKED here: needs SeCreateSymbolicLinkPrivilege or Developer Mode]",
    async () => {
      const target = writeRecord("real-record.json");
      const link = path.join(root, "service-link.json");
      symlinkSync(target, link);
      const error = await refusalOf(read(link));
      expect(error.refusal).toBe("registration_not_regular");
    },
  );

  it("refuses a directory reparse point at lstat", async () => {
    const target = path.join(root, "target-directory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "service.json"), JSON.stringify(record()));
    const link = path.join(root, "service-junction.json");
    // A directory junction on Windows, a directory symlink elsewhere: both are
    // reparse points and neither needs elevation. The lstat assertion proves a
    // real reparse point was created before the reader is asked to refuse it.
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const error = await refusalOf(read(link));
    expect(error.refusal).toBe("registration_not_regular");
  });

  it("refuses a directory at lstat", async () => {
    const directory = path.join(root, "service.json");
    mkdirSync(directory, { recursive: true });
    const error = await refusalOf(read(directory));
    expect(error.refusal).toBe("registration_not_regular");
  });

  it("refuses again at fstat when the opened object is not a regular file", async () => {
    const file = writeRecord("swapped.json");
    let closed = 0;
    const openFile: RegistrationFileOpener = async () => ({
      stat: async () => ({ isFile: () => false }),
      read: async () => ({ bytesRead: 0 }),
      close: async () => {
        closed += 1;
      },
    });

    const error = await refusalOf(read(file, { openFile }));
    expect(error.refusal).toBe("registration_not_regular");
    expect(closed).toBe(1);
  });
});

describe("BT11 — TBAi never writes the registration", () => {
  it("opens the record readonly and contains no write or rename path", () => {
    const source = stripComments(
      readFileSync(path.join(REPO_ROOT, "src/services/opencode/registration.ts"), "utf8"),
    );
    expect(source).toContain('fs.open(file, "r")');
    expect(source).not.toMatch(/fs\.(rewrite|writeFile|appendFile|rename|unlink|rm)\b/);
    expect(source).not.toMatch(/open\([^)]*["'](w|a|r\+)/);
  });
});

describe("BT12 — stable versus beta", () => {
  it("cannot distinguish them when both share the filename and version", async () => {
    expect(registrationFilenameForChannel("latest")).toBe(registrationFilenameForChannel("beta"));

    const file = writeRecord("shared.json");
    const latest = await read(file, { channel: "latest" });
    const beta = await read(file, { channel: "beta" });

    expect(latest.origin).toBe(beta.origin);
    expect(latest.version).toBe(beta.version);
    // The record carries no channel field; the documented limitation is that
    // the gate cannot tell a stable build from a beta build that reports the
    // same version. No fabricated detection is added (§2.2, D2).
    expect(Object.keys(latest)).not.toContain("channel");
  });
});

describe("BT13 — the byte cap applies to actual bytes", () => {
  it("refuses a file larger than the cap and never requests more than cap + 1", async () => {
    const file = writeRecord("oversized.json");
    const memory = memoryHandle(new TextEncoder().encode(" ".repeat(MAX_BYTES + 1)));
    let requested = 0;
    let closed = 0;
    const openFile: RegistrationFileOpener = async () => ({
      stat: memory.handle.stat,
      read: async (buffer, offset, length, position) => {
        requested += length;
        return memory.handle.read(buffer, offset, length, position);
      },
      close: async () => {
        closed += 1;
        await memory.handle.close();
      },
    });

    const error = await refusalOf(read(file, { openFile }));
    expect(error.refusal).toBe("registration_too_large");
    expect(requested).toBe(MAX_BYTES + 1);
    expect(closed).toBe(1);
  });
});

describe("BT14 — a file that grows after lstat", () => {
  it("refuses a file that grew past the cap before the read completed", async () => {
    const file = writeRecord("grown.json");
    const openFile: RegistrationFileOpener = async (target) => {
      const handle = await fs.open(target, "r");
      writeFileSync(target, `${JSON.stringify(record())}${"x".repeat(MAX_BYTES)}`);
      return handle;
    };

    const error = await refusalOf(read(file, { openFile }));
    expect(error.refusal).toBe("registration_too_large");
  });

  it("accepts a file that grew but stayed under the cap, using the bytes read", async () => {
    const file = writeRecord("grew-small.json");
    const openFile: RegistrationFileOpener = async (target) => {
      const handle = await fs.open(target, "r");
      writeFileSync(target, `${JSON.stringify(record())}\n   \n`);
      return handle;
    };

    const found = await read(file, { openFile });
    expect(found.origin).toBe(ORIGIN);
  });
});

describe("BT15 — one open, handle bytes, close on every path", () => {
  it("opens once and closes once on success", async () => {
    const file = writeRecord("success.json");
    let opens = 0;
    let closes = 0;
    const openFile: RegistrationFileOpener = async (target) => {
      opens += 1;
      const handle = await fs.open(target, "r");
      return {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async () => {
          closes += 1;
          await handle.close();
        },
      };
    };

    await read(file, { openFile });
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  it("closes the handle on a validation refusal", async () => {
    const file = writeRecord("invalid.json", record({ pid: "nope" }));
    let closes = 0;
    const openFile: RegistrationFileOpener = async (target) => {
      const handle = await fs.open(target, "r");
      return {
        stat: () => handle.stat(),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async () => {
          closes += 1;
          await handle.close();
        },
      };
    };

    const error = await refusalOf(read(file, { openFile }));
    expect(error.refusal).toBe("registration_invalid_pid");
    expect(closes).toBe(1);
  });

  it("closes the handle when the read aborts between operations", async () => {
    const file = writeRecord("aborted.json");
    const controller = new AbortController();
    let closes = 0;
    const openFile: RegistrationFileOpener = async (target) => {
      const handle = await fs.open(target, "r");
      return {
        stat: () => handle.stat(),
        read: async (buffer, offset, length, position) => {
          const result = await handle.read(buffer, offset, length, position);
          controller.abort();
          return result;
        },
        close: async () => {
          closes += 1;
          await handle.close();
        },
      };
    };

    const error = await refusalOf(read(file, { openFile, signal: controller.signal }));
    expect(error.refusal).toBe("registration_read_failed");
    expect(closes).toBe(1);
  });

  it("parses only the bytes the handle returned and never re-opens the path", async () => {
    const file = writeRecord("on-disk.json");
    const memory = memoryHandle(
      new TextEncoder().encode(JSON.stringify(record({ url: OTHER_ORIGIN }))),
    );
    let opens = 0;
    const openFile: RegistrationFileOpener = async () => {
      opens += 1;
      return memory.handle;
    };

    const found = await read(file, { openFile });
    expect(found.origin).toBe(OTHER_ORIGIN);
    expect(opens).toBe(1);
    expect(memory.closes()).toBe(1);
  });
});

describe("BT16 — the deadline is checked after parsing", () => {
  it("refuses a read that completed over budget and discards the parsed record", async () => {
    const file = writeRecord("slow.json");
    let elapsed = false;
    const openFile: RegistrationFileOpener = async (target) => {
      const handle = await fs.open(target, "r");
      return {
        stat: () => handle.stat(),
        read: async (buffer, offset, length, position) => {
          const result = await handle.read(buffer, offset, length, position);
          if (result.bytesRead === 0) elapsed = true;
          return result;
        },
        close: () => handle.close(),
      };
    };
    const now = () => (elapsed ? OPENCODE_CONFIG.registrationReadTimeoutMs + 1 : 0);

    const error = await refusalOf(read(file, { openFile, now }));
    expect(error.refusal).toBe("registration_read_timeout");
  });
});
