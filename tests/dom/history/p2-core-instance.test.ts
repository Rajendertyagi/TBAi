/**
 * P2 — regression: the write-back binding requires ONE `@assistant-ui/core`.
 *
 * `symbolInnerMessage` is a module-local `Symbol()`, NOT `Symbol.for()`
 * (external-store-message.js). A second `@assistant-ui/core` instance would
 * therefore produce objects whose bindings are invisible to the reader used for
 * write-back — silently, with no error and no empty-array signal until a write
 * loses a message.
 *
 * The installed tree genuinely carries two generations (react 0.15.20 /
 * ai-sdk 0.0.6 on core 0.3.19, alongside react 0.15.25 / ai-sdk 0.0.11 on core
 * 0.3.24), so this is asserted rather than assumed.
 */

import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindExternalStoreMessage, getExternalStoreMessages } from "@assistant-ui/react";
import { getExternalStoreMessages as coreAnchored } from "../../helpers/dom/resolve.ts";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Realpath of the `@assistant-ui/core` copy a package from `web/` resolves to. */
const coreOf = (fromDir: string, pkg: string): string => {
  const req = createRequire(path.join(fromDir, "package.json"));
  const entry = req.resolve(pkg);
  const nested = createRequire(entry);
  return fs.realpathSync(
    path.dirname(path.dirname(nested.resolve("@assistant-ui/core/package.json"))),
  );
};

describe("P2 — single-instance @assistant-ui/core", () => {
  it("web resolves react and ai-sdk onto the same core instance", () => {
    const viaReact = coreOf(webDir, "@assistant-ui/react");
    const viaAiSdk = coreOf(webDir, "@assistant-ui/ai-sdk");

    console.log("\n=== @assistant-ui/core resolution (from web/) ===");
    console.log(`  via @assistant-ui/react : ${viaReact}`);
    console.log(`  via @assistant-ui/ai-sdk : ${viaAiSdk}`);

    expect(viaReact).toBe(viaAiSdk);
  });

  it("a binding written through the public API is readable by the runtime's reader", () => {
    // Functional proof that both surfaces share the module-local Symbol: bind via
    // the public `@assistant-ui/react` export, read via the core-anchored reader
    // the runtime uses.
    const target = { id: "m1" } as unknown as Record<string, unknown>;
    bindExternalStoreMessage(target as never, { id: "inner-1" } as never);

    const viaPublic = getExternalStoreMessages(target as never) as Array<{ id: string }>;
    const viaCore = coreAnchored(target as never) as Array<{ id: string }>;

    console.log(`  public read   : ${viaPublic.map((m) => m.id).join(",") || "(none)"}`);
    console.log(`  core-anchored : ${viaCore.map((m) => m.id).join(",") || "(none)"}`);

    expect(viaPublic.map((m) => m.id)).toEqual(["inner-1"]);
    expect(viaCore.map((m) => m.id)).toEqual(["inner-1"]);
  });
});
