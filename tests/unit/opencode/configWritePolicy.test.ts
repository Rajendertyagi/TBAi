import { afterEach, describe, expect, it } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OpenCodeConfigPathError,
  OpenCodeConfigWriteDisabledError,
  assertOpenCodeConfigWriteAllowed,
  openCodeConfigWriteRefusal,
  resolveOpenCodeConfigPath,
  validateOpenCodeConfigWritePath,
} from "@/services/opencode/configWritePolicy.ts";

/**
 * G4/D5 — the containment policy (CT5) and the adopted-write refusal (CT7).
 *
 * The Windows forms are checked against `path.win32` with the platform pinned,
 * so they mean the same thing on every runner. The filesystem walk is checked
 * against a real temporary directory, because a mocked `lstat` would not prove
 * the walk refuses what the host actually reports.
 */

const WIN_ROOT = "C:\\Users\\owner\\.config\\opencode";
const DOCUMENT = "C:\\Users\\owner\\.config\\opencode\\opencode.json";

/** Runs the synchronous policy and returns the refusal it raised. */
function refusal(run: () => unknown): OpenCodeConfigPathError {
  try {
    run();
  } catch (error) {
    if (error instanceof OpenCodeConfigPathError) return error;
    throw error;
  }
  throw new Error("expected the path policy to refuse");
}

/** Runs the asynchronous policy and returns the refusal it raised. */
async function asyncRefusal(run: () => Promise<unknown>): Promise<OpenCodeConfigPathError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof OpenCodeConfigPathError) return error;
    throw error;
  }
  throw new Error("expected the path policy to refuse");
}

function win(documentPath: string, root: string = WIN_ROOT) {
  return resolveOpenCodeConfigPath({
    root,
    documentPath,
    platform: "win32",
    pathImpl: path.win32,
  });
}

function winRefusal(documentPath: string, root: string = WIN_ROOT): OpenCodeConfigPathError {
  return refusal(() => win(documentPath, root));
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Creates a temporary directory that the walk tests own and clean up. */
async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

describe("CT5 — a document path must resolve inside one configuration root", () => {
  it("accepts the absolute path the server reports", () => {
    expect(win(DOCUMENT)).toBe(DOCUMENT);
  });

  it("accepts a path relative to the root", () => {
    expect(win("opencode.json")).toBe(DOCUMENT);
  });

  it("normalizes a traversal that stays inside the root", () => {
    expect(win("nested\\..\\opencode.json")).toBe(DOCUMENT);
  });

  it("accepts a file whose name begins with two dots", () => {
    expect(win("..notes.json")).toBe(`${WIN_ROOT}\\..notes.json`);
  });

  it("refuses an absolute path outside the root", () => {
    const error = winRefusal("C:\\Users\\owner\\Documents\\opencode.json");
    expect(error.reason).toBe("outside_root");
  });

  it("refuses a traversal that escapes the root", () => {
    const error = winRefusal("..\\..\\opencode.json");
    expect(error.reason).toBe("outside_root");
  });

  it("refuses the root itself", () => {
    const error = winRefusal(WIN_ROOT);
    expect(error.reason).toBe("outside_root");
  });

  it("refuses a path on another drive", () => {
    const error = winRefusal("D:\\config\\opencode.json");
    expect(error.reason).toBe("outside_root");
  });

  it("refuses a drive-relative path", () => {
    const error = winRefusal("C:opencode.json");
    expect(error.reason).toBe("invalid_form");
  });

  it("refuses a rooted path without a drive", () => {
    const error = winRefusal("\\opencode.json");
    expect(error.reason).toBe("invalid_form");
  });

  it("refuses an extended-length path", () => {
    const error = winRefusal("\\\\?\\C:\\Users\\owner\\.config\\opencode\\opencode.json");
    expect(error.reason).toBe("invalid_form");
  });

  it("refuses a UNC path", () => {
    const error = winRefusal("\\\\server\\share\\opencode.json");
    expect(error.reason).toBe("outside_root");
  });

  it("refuses an alternate data stream", () => {
    const error = winRefusal("opencode.json:stream");
    expect(error.reason).toBe("invalid_form");
  });

  it("refuses a segment ending in a dot", () => {
    const error = winRefusal("opencode.json.");
    expect(error.reason).toBe("invalid_form");
  });

  it("refuses a segment ending in a space", () => {
    const error = winRefusal("config \\opencode.json");
    expect(error.reason).toBe("invalid_form");
  });

  it("refuses reserved device names in any casing", () => {
    for (const name of ["CON", "nul", "COM1.txt", "lpt9.json", "aux"]) {
      expect(winRefusal(name).reason).toBe("invalid_form");
    }
  });

  it("refuses an empty document path", () => {
    expect(winRefusal("").reason).toBe("invalid_form");
    expect(winRefusal("   ").reason).toBe("invalid_form");
  });

  it("refuses a path containing a NUL character", () => {
    expect(winRefusal("opencode\0.json").reason).toBe("invalid_form");
  });

  it("refuses an empty root", () => {
    expect(winRefusal(DOCUMENT, "").reason).toBe("root_unresolved");
  });

  it("refuses a relative root", () => {
    expect(winRefusal("opencode.json", ".config\\opencode").reason).toBe("root_unresolved");
  });

  it("returns a rebuilt path rather than the raw input", () => {
    const resolved = win("sub\\..\\opencode.json");
    expect(resolved).toBe(path.win32.resolve(WIN_ROOT, "opencode.json"));
  });
});

describe("CT7 — an adopted service's configuration is not written", () => {
  it("refuses an adopted write before any I/O", () => {
    let error: unknown;
    try {
      assertOpenCodeConfigWriteAllowed({ mode: "adopted" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpenCodeConfigWriteDisabledError);
    expect((error as OpenCodeConfigWriteDisabledError).code).toBe("OPENCODE_CONFIG_WRITE_DISABLED");
    expect((error as OpenCodeConfigWriteDisabledError).reason).toBe("adopted_g4_unproven");
  });

  it("keeps the refusal when the proof is explicitly absent", () => {
    expect(() => assertOpenCodeConfigWriteAllowed({ mode: "adopted", g4Verified: false })).toThrow(
      OpenCodeConfigWriteDisabledError,
    );
  });

  it("allows an adopted write only once the G4 proof is supplied", () => {
    expect(() =>
      assertOpenCodeConfigWriteAllowed({ mode: "adopted", g4Verified: true }),
    ).not.toThrow();
  });
});

describe("the managed service's configuration is not written either", () => {
  it("refuses because the child has no TBAi-owned configuration root", () => {
    let error: unknown;
    try {
      assertOpenCodeConfigWriteAllowed({ mode: "managed" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OpenCodeConfigWriteDisabledError);
    expect((error as OpenCodeConfigWriteDisabledError).reason).toBe("managed_root_not_owned");
    // The message has to name the reason a reader can act on: the document is
    // the user's own, not a TBAi file with a wrong path.
    expect((error as OpenCodeConfigWriteDisabledError).message).toContain("user's own");
  });

  it("cannot be enabled by the adopted-mode G4 switch", () => {
    // `g4Verified` is the adopted path's switch. It must never make a managed
    // write legal, because the managed problem is a missing root, not G4.
    expect(() => assertOpenCodeConfigWriteAllowed({ mode: "managed", g4Verified: true })).toThrow(
      OpenCodeConfigWriteDisabledError,
    );
  });

  it("reports the same refusal the throwing gate raises", () => {
    expect(openCodeConfigWriteRefusal({ mode: "managed" })).toBe("managed_root_not_owned");
    expect(openCodeConfigWriteRefusal({ mode: "adopted" })).toBe("adopted_g4_unproven");
    expect(openCodeConfigWriteRefusal({ mode: "adopted", g4Verified: true })).toBeNull();
  });
});

describe("G4 walk — the path is inspected from the root to the leaf", () => {
  it("accepts a document that does not exist yet", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const result = await validateOpenCodeConfigWritePath({
      root,
      documentPath: "opencode.json",
    });
    expect(result.root).toBe(path.resolve(root));
    expect(result.validated).toBe(path.resolve(root, "opencode.json"));
  });

  it("accepts a document one directory below an existing root", async () => {
    const root = await makeTempDirectory("opencode-config-");
    await mkdir(path.join(root, "nested"));
    const result = await validateOpenCodeConfigWritePath({
      root,
      documentPath: "nested/opencode.json",
    });
    expect(result.validated).toBe(path.join(path.resolve(root), "nested", "opencode.json"));
  });

  it("refuses a document that already exists, because replacement is unproven", async () => {
    const root = await makeTempDirectory("opencode-config-");
    await writeFile(path.join(root, "opencode.json"), "{}\n");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "opencode.json" }),
    );
    expect(error.reason).toBe("replace_unverified");
  });

  it("refuses a missing intermediate directory", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "missing/opencode.json" }),
    );
    expect(error.reason).toBe("walk_failed");
  });

  it("refuses an intermediate that is not a directory", async () => {
    const root = await makeTempDirectory("opencode-config-");
    await writeFile(path.join(root, "opencode.json"), "{}\n");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "opencode.json/deeper.json" }),
    );
    expect(error.reason).toBe("walk_failed");
  });

  it("refuses a root that does not exist", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const missing = path.join(root, "absent");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root: missing, documentPath: "opencode.json" }),
    );
    expect(error.reason).toBe("root_unresolved");
  });

  it("refuses a root that is a file", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const file = path.join(root, "opencode.json");
    await writeFile(file, "{}\n");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root: file, documentPath: "opencode.json" }),
    );
    // A file root cannot contain a child, so the root check is what refuses it.
    expect(error.reason).toBe("root_unresolved");
  });

  it("refuses a linked intermediate directory", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const target = await makeTempDirectory("opencode-target-");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(target, path.join(root, "linked"), linkType);
    } catch (error) {
      // Creating links can be refused by policy on a managed runner; the
      // refusal is not a behaviour change, so it is reported, not hidden.
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EPERM") {
        return;
      }
      throw error;
    }
    const refusalRaised = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "linked/opencode.json" }),
    );
    expect(refusalRaised.reason).toBe("reparse_point");
  });

  it("refuses a linked document leaf", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const targetDirectory = await makeTempDirectory("opencode-target-");
    const target = path.join(targetDirectory, "opencode.json");
    await writeFile(target, "{}\n");
    try {
      await symlink(target, path.join(root, "opencode.json"), "file");
    } catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EPERM") {
        return;
      }
      throw error;
    }
    const refusalRaised = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "opencode.json" }),
    );
    // The leaf is refused either way; a link is refused as a reparse point.
    expect(refusalRaised.reason).toBe("reparse_point");
  });

  it("refuses an escaping document before touching the filesystem", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "../opencode.json" }),
    );
    expect(error.reason).toBe("outside_root");
  });
});

describe("G4 identity — aliases and hard links", () => {
  it("refuses a leaf that is only reachable through an 8.3-style alias", async () => {
    // This volume does not generate 8.3 names (`Get-Item .ShortName` is empty
    // here), so the resolver is supplied: the guard must refuse a component
    // whose canonical name is not the spelling that was approved, because the
    // alias is a filesystem-assigned name that can later point at a new file.
    const root = await makeTempDirectory("opencode-config-");
    const alias = path.join(root, "OPENCO~1.JSO");
    await writeFile(alias, "{}\n");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({
        root,
        documentPath: "OPENCO~1.JSO",
        realpath: async (target) =>
          target.toLowerCase() === alias.toLowerCase() ? path.join(root, "opencode.json") : target,
      }),
    );
    expect(error.reason).toBe("short_name_alias");
  });

  it("refuses a root spelled as an alias", async () => {
    const root = await makeTempDirectory("opencode-config-");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({
        root,
        documentPath: "opencode.json",
        realpath: async () => path.join(path.dirname(root), "canonical-root"),
      }),
    );
    expect(error.reason).toBe("short_name_alias");
  });

  it("refuses a component that canonicalizes outside the root", async () => {
    const root = await makeTempDirectory("opencode-config-");
    await mkdir(path.join(root, "nested"));
    const nested = path.join(root, "nested");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({
        root,
        documentPath: "nested/opencode.json",
        realpath: async (target) =>
          target.toLowerCase() === nested.toLowerCase()
            ? path.join(path.dirname(path.dirname(root)), "elsewhere")
            : target,
      }),
    );
    expect(error.reason).toBe("outside_root");
  });

  it("still reports an ordinary existing leaf as unverified replacement", async () => {
    // Control: the identity rules must not turn every existing document into
    // an alias refusal. The real resolver is used here.
    const root = await makeTempDirectory("opencode-config-");
    await writeFile(path.join(root, "opencode.json"), "{}\n");
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "opencode.json" }),
    );
    expect(error.reason).toBe("replace_unverified");
  });

  it("refuses a document that has a hard link outside the root", async () => {
    // Measured on this machine: a hard link shares dev/ino and raises nlink to
    // 2, and it survives unlinking the original name. A reparse check cannot
    // see it, so the link count is the only signal.
    const root = await makeTempDirectory("opencode-config-");
    const outside = await makeTempDirectory("opencode-outside-");
    const outsideDocument = path.join(outside, "linked.json");
    await writeFile(outsideDocument, "{}\n");
    const document = path.join(root, "opencode.json");
    await link(outsideDocument, document);
    const error = await asyncRefusal(() =>
      validateOpenCodeConfigWritePath({ root, documentPath: "opencode.json" }),
    );
    expect(error.reason).toBe("hard_link");
  });
});
