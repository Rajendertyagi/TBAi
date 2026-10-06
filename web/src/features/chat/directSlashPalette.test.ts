/**
 * The Direct slash-command palette.
 *
 * ## The gap this closes
 *
 * `/compact` existed, worked, and was undiscoverable. `slashCommandsEnabled` gated the
 * palette on an **OpenCode-only** condition — `isCodeSurface || showOpenCodeDraft` —
 * and the built-in compact entry on `shouldOfferCompact(isCodeSurface, …)`, whose
 * runtime context is null on Direct by design. So on Direct, typing `/` showed nothing
 * and the command could only be reached by typing all seven characters. `/compact
 * <instructions>` had no discoverable form at all.
 *
 * The gate was correct for the OpenCode feed — those commands cannot run on Direct —
 * and wrong for the built-in, which is Direct's own and always could run.
 *
 * ## What is protected here
 *
 * That Direct contributes its OWN entries, that they are the Direct spellings rather
 * than OpenCode's, and — the part that actually caused the gap — that the palette's
 * **render gate is the entry list, not a surface flag**. A gate that can be true while
 * the list is empty (or false while it is not) is how this hid for so long.
 */

import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { stripComments } from "../../testing/source-scope";
import { applyCommandSelection } from "../opencode/slashCommands";
import {
  DIRECT_COMPACT_COMMANDS,
  commandNameOf,
  isDirectCompactCommand,
} from "./compactCommand";
import { buildDirectCompactEntries } from "./directCompactEntries";

/** The Composer, comments stripped. `import.meta.dir` is `web/src/features/chat`. */
function composer(): string {
  return stripComments(
    fs.readFileSync(
      path.resolve(import.meta.dir, "..", "..", "components", "Composer.tsx"),
      "utf8",
    ),
  );
}

describe("Direct offers its own commands in the palette", () => {
  it("mounts the palette whenever there are entries, not on a surface flag", () => {
    // The defect in one assertion. Gating the render on `slashCommandsEnabled` hid the
    // palette on Direct even though Direct had commands to show.
    expect(composer()).toContain("{slashEntries.length > 0 && (");
    expect(composer()).not.toContain("{slashCommandsEnabled && (");
  });

  it("contributes the Direct spellings, not the OpenCode feed", () => {
    // Built from the shared constant, so `/compress` cannot drift from what the server
    // accepts. The mapping lives in the builder now rather than inline in the composer,
    // which is what makes the token→name conversion executable by the tests below.
    const builder = stripComments(
      fs.readFileSync(path.resolve(import.meta.dir, "directCompactEntries.ts"), "utf8"),
    );
    expect(builder).toContain("DIRECT_COMPACT_COMMANDS.map(");
    // And the OpenCode feed stays behind its own gate, still excluded from Direct.
    expect(composer()).toContain("slashCommandsEnabled ? [] : directSlashEntries");
  });

  it("offers both accepted spellings", () => {
    expect(DIRECT_COMPACT_COMMANDS).toEqual(["/compact", "/compress"]);
  });

  it("describes the argument form, which has no other way to be discovered", () => {
    const src = composer();
    expect(src).toContain("composerConfig.copy.compactCommandDescription");
    // No menu literals in the component.
    expect(src).not.toContain("Summarise earlier turns");
  });

  it("selection only INSERTS text — it never compacts by itself", () => {
    const src = composer();
    // Selection reaches the composer through the shared insertion helper and nothing
    // else, so selecting a row cannot compact on its own: the command runs on submit.
    const entries = src.slice(src.indexOf("const directSlashEntries"));
    expect(entries.slice(0, entries.indexOf("const slashEntries"))).toContain(
      "applyCommandSelection(composerText, name)",
    );
    // Critically: no direct transport call from the palette.
    expect(entries.slice(0, entries.indexOf("const slashEntries"))).not.toContain(
      "runDirectCompact",
    );
  });

  it("runs through the same handler a typed command uses", () => {
    const src = composer();
    // One path means one in-flight flag, one append, one divider row.
    expect(src).toContain("parseDirectCompactCommand(composerText)");
    expect(src).toContain("runDirectCompactCommand(directCommand)");
  });

  it("keeps the Code surface's own entries untouched", () => {
    const src = composer();
    expect(src).toContain("toSlashCommands(openCodeCommands");
    expect(src).toContain("buildCompactEntry(");
    expect(src).toContain("shouldOfferCompact(isCodeSurface, openCodeRuntimeContext)");
  });
});

/**
 * The entries are exercised by RUNNING them, not by grepping the composer.
 *
 * The previous version of this file asserted that the composer contained the call
 * shape `applyCommandSelection(composerText, name)`. That assertion passed while the
 * palette inserted `//compact ` and sent the command to the model as an ordinary
 * message — the string was right and the value flowing through it was not. A
 * source assertion cannot see the difference, so these compose the real builder with
 * the real insertion helper and assert on the string that reaches the composer.
 */
describe("selecting a Direct palette row produces a runnable command", () => {
  const DESCRIPTION = "Summarise earlier turns to free up context";

  /** Compose exactly as `Composer.tsx` does, and report the text it would insert. */
  function selecting(label: string, composerText: string): () => string {
    let inserted = "";
    const entries = buildDirectCompactEntries(DESCRIPTION, (name) => {
      inserted = applyCommandSelection(composerText, name);
    });
    const row = entries.find((entry) => entry.label === label);
    if (!row) throw new Error(`no palette row labelled ${label}`);
    return () => {
      row.execute();
      return inserted;
    };
  }

  it("replaces the bare sigil that opened the palette", () => {
    // Typing `/` opens the palette AND leaves the sigil in the composer, so the row
    // has to replace it. This is the regression: the row received the token
    // `/compact` rather than the name `compact`, `commandLabel` added a second
    // sigil, and the result matched no command at all.
    expect(selecting("/compact", "/")()).toBe("/compact ");
  });

  it("never emits a doubled sigil from an empty composer", () => {
    // The other opening state: the palette triggered programmatically with nothing
    // typed. Same rule, different starting text.
    expect(selecting("/compact", "")()).toBe("/compact ");
  });

  it("replaces a partially typed token", () => {
    expect(selecting("/compact", "/comp")()).toBe("/compact ");
  });

  it("replaces the trigger while keeping what came before it", () => {
    expect(selecting("/compact", "please run /")()).toBe("please run /compact ");
  });

  it("handles the alias through the same path", () => {
    expect(selecting("/compress", "/")()).toBe("/compress ");
  });

  it("produces text the submit guard actually recognises as the command", () => {
    // The assertion that matters: the whole point of the palette is reachability, so
    // what it inserts must be something `parseDirectCompactCommand` accepts. Before
    // the fix this was `false` for both rows.
    for (const label of ["/compact", "/compress"]) {
      expect(isDirectCompactCommand(selecting(label, "/")())).toBe(true);
    }
  });

  it("leaves the command editable by appending a trailing space", () => {
    // Instructions are typed after the command, so the inserted text must end in a
    // space rather than flush against the command word.
    expect(selecting("/compact", "/")()).toMatch(/\s$/);
  });

  it("labels rows with the sigil and ids without it", () => {
    // The convention the feed's and the built-in's builders already follow: the label
    // is what the user reads, the id is a stable key.
    const entries = buildDirectCompactEntries(DESCRIPTION, () => {});
    expect(entries.map((entry) => entry.label)).toEqual(["/compact", "/compress"]);
    expect(entries.map((entry) => entry.id)).toEqual(["direct-compact", "direct-compress"]);
  });

  it("passes a sigil-less name to the insertion callback", () => {
    const seen: string[] = [];
    for (const entry of buildDirectCompactEntries(DESCRIPTION, (name) => seen.push(name))) {
      entry.execute();
    }
    expect(seen).toEqual(["compact", "compress"]);
  });
});

describe("commandNameOf", () => {
  it("strips exactly one leading sigil", () => {
    expect(commandNameOf("/compact")).toBe("compact");
  });

  it("leaves a sigil-less name alone, so it is idempotent", () => {
    expect(commandNameOf("compact")).toBe("compact");
    expect(commandNameOf(commandNameOf("/compact"))).toBe("compact");
  });

  it("does not treat a later sigil as the leading one", () => {
    expect(commandNameOf("a/b")).toBe("a/b");
  });
});
