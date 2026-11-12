import { describe, expect, it } from "bun:test";
import { normalizeSectionOrderStrict } from "@/services/preferences/registry";
import {
  normalizeSectionOrder,
  normalizeSectionOrderLenient,
} from "@web/features/desktop/state/sidebarSections";

/**
 * Frontend/backend sectionOrder parity (strict semantics).
 * Backend is authoritative for snapshot validation; frontend strict normalizer
 * must match. Lenient helper is for non-authoritative contexts only.
 */
describe("sectionOrder frontend/backend parity", () => {
  it("strict normalizers agree on valid cases", () => {
    const cases: unknown[] = [
      undefined,
      null,
      [],
      ["folders", "chats"],
      ["chats", "folders"],
      ["chats"],
      ["folders", "folders", "chats"],
    ];
    for (const value of cases) {
      expect([...normalizeSectionOrder(value)] as string[]).toEqual([
        ...normalizeSectionOrderStrict(value),
      ] as string[]);
    }
  });

  it("strict normalizers reject the same invalid cases", () => {
    const cases: unknown[] = ["folders", [1, 2], ["folders", "unknown"], { folders: true }];
    for (const value of cases) {
      expect(() => normalizeSectionOrder(value)).toThrow();
      expect(() => normalizeSectionOrderStrict(value)).toThrow();
    }
  });

  it("lenient normalizer falls back to default for invalid/non-authoritative input", () => {
    expect([...normalizeSectionOrderLenient("folders")]).toEqual(["folders", "chats"]);
    expect([...normalizeSectionOrderLenient(["unknown"])]).toEqual(["folders", "chats"]);
  });
});
