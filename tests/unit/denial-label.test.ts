import { describe, it, expect } from "bun:test";
import { denialOf } from "../../web/src/tools/filesystem/ui";

const approval = (approved?: boolean) =>
  (approved === undefined ? undefined : ({ approved }) as never);

describe("denialOf", () => {
  it("treats approved:false as denial regardless of text", () => {
    expect(
      denialOf({ error: "Denied by user" }, approval(false)),
    ).toBe("Denied by user");
    expect(denialOf({ error: "nope" }, approval(false))).toBe("nope");
  });

  it("treats post-approval execution failures as NOT denial", () => {
    expect(
      denialOf(
        { error: 'Symlink target for "test_folder/test.txt" escapes the workspace' },
        approval(true),
      ),
    ).toBeNull();
    expect(
      denialOf({ error: 'Path "/" is outside the workspace' }, approval(true)),
    ).toBeNull();
    expect(denialOf({ error: "boom" }, undefined)).toBeNull();
  });

  it("keeps genuine denies reloaded without a marker as denial", () => {
    expect(denialOf({ error: "Denied by user" }, undefined)).toBe(
      "Denied by user",
    );
    expect(denialOf({ error: "Tool approval denied" }, undefined)).toBe(
      "Tool approval denied",
    );
  });

  it("returns null for non-error results", () => {
    expect(denialOf({ ok: true }, approval(false))).toBeNull();
    expect(denialOf(undefined, approval(false))).toBeNull();
    expect(denialOf(null, undefined)).toBeNull();
    expect(denialOf({ error: 42 }, approval(false))).toBeNull();
  });
});
