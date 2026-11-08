import { describe, expect, it } from "bun:test";
import { opencodeToolActivityLabel } from "@web/features/opencode/toolActivityLabel";

describe("OpenCode tool activity labels", () => {
  it("maps the file and search tools to the verb each card shows", () => {
    expect(opencodeToolActivityLabel("read")).toBe("Reading…");
    expect(opencodeToolActivityLabel("write")).toBe("Writing…");
    expect(opencodeToolActivityLabel("edit")).toBe("Editing…");
    expect(opencodeToolActivityLabel("glob")).toBe("Finding files…");
    expect(opencodeToolActivityLabel("grep")).toBe("Searching…");
  });

  it("labels patch as applying a patch, as its card already does", () => {
    // `patch` rewrites files like `edit`, but the patch card says
    // "Applying patch…" — the activity row must not disagree with the card.
    expect(opencodeToolActivityLabel("patch")).toBe("Applying patch…");
  });

  it("owns shell, the OpenCode spelling the Direct resolver only carries temporarily", () => {
    expect(opencodeToolActivityLabel("shell")).toBe("Running…");
  });

  it("labels execute as a script run rather than a bare command", () => {
    expect(opencodeToolActivityLabel("execute")).toBe("Running script…");
  });

  it("maps the network, skill, subagent and question tools", () => {
    expect(opencodeToolActivityLabel("websearch")).toBe("Searching the web…");
    expect(opencodeToolActivityLabel("webfetch")).toBe("Fetching…");
    expect(opencodeToolActivityLabel("skill")).toBe("Loading skill…");
    expect(opencodeToolActivityLabel("subagent")).toBe("Running subagent…");
    expect(opencodeToolActivityLabel("question")).toBe("Waiting for your answer…");
  });

  // `v2Tools.ts` documents these as v1 spellings the server still emits for
  // different builds. Both are registered cards, so both need a label.
  it("maps the v1 spellings v2 still accepts onto their replacements", () => {
    expect(opencodeToolActivityLabel("bash")).toBe("Running…");
    expect(opencodeToolActivityLabel("task")).toBe("Running subagent…");
  });

  it("falls back to the identifier when no tool owns it", () => {
    expect(opencodeToolActivityLabel("brand_new_tool")).toBe("brand_new_tool…");
    expect(opencodeToolActivityLabel("opencode.models")).toBe("opencode.models…");
  });
});
