/**
 * Zod validation for `disabledTools` on the MCP server create/update payloads
 * (Phase 1 — per-tool filtering, input half).
 *
 * Pins the exact schema contract in `src/lib/validation.ts`:
 *
 *   disabledTools: z.array(z.string().max(200)).max(500).optional().nullable()
 *
 * i.e. an optional, nullable array of short strings, capped at 500 entries —
 * and, because `mcpServerUpdateSchema` is `mcpServerCreateSchema.partial()`,
 * the same field shape applies to every update payload.
 */
import { describe, it, expect } from "bun:test";
import { mcpServerCreateSchema, mcpServerUpdateSchema } from "@/lib/validation.ts";

/** A minimal valid create payload; each case overrides one field. */
const base = {
  name: "fixture-server",
  transport: "http" as const,
  url: "http://localhost:3000",
};

describe("mcpServerCreateSchema — disabledTools accepted", () => {
  it("accepts an array of strings and parses it through", () => {
    const r = mcpServerCreateSchema.parse({ ...base, disabledTools: ["echo", "fail"] });
    expect(r.disabledTools).toEqual(["echo", "fail"]);
  });

  it('accepts null (explicit "enable everything")', () => {
    const r = mcpServerCreateSchema.parse({ ...base, disabledTools: null });
    expect(r.disabledTools).toBeNull();
  });

  it("accepts an omitted field", () => {
    const r = mcpServerCreateSchema.parse({ ...base });
    expect(r.disabledTools).toBeUndefined();
  });

  it("accepts the empty array (nothing disabled)", () => {
    const r = mcpServerCreateSchema.parse({ ...base, disabledTools: [] });
    expect(r.disabledTools).toEqual([]);
  });

  it("accepts the boundary values: exactly 500 entries, 200-char strings", () => {
    const fiveHundred = Array.from({ length: 500 }, (_, i) => `tool_${i}`);
    const twoHundredChars = "a".repeat(200);
    expect(mcpServerCreateSchema.safeParse({ ...base, disabledTools: fiveHundred }).success).toBe(
      true,
    );
    expect(
      mcpServerCreateSchema.safeParse({ ...base, disabledTools: [twoHundredChars] }).success,
    ).toBe(true);
  });
});

describe("mcpServerCreateSchema — disabledTools rejected", () => {
  it("rejects a non-string entry", () => {
    const r = mcpServerCreateSchema.safeParse({ ...base, disabledTools: ["echo", 42] });
    expect(r.success).toBe(false);
  });

  it("rejects more than 500 entries", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `tool_${i}`);
    const r = mcpServerCreateSchema.safeParse({ ...base, disabledTools: tooMany });
    expect(r.success).toBe(false);
  });

  it("rejects a string longer than 200 characters", () => {
    const r = mcpServerCreateSchema.safeParse({
      ...base,
      disabledTools: ["a".repeat(201)],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-array value", () => {
    const r = mcpServerCreateSchema.safeParse({ ...base, disabledTools: "echo" });
    expect(r.success).toBe(false);
  });
});

describe("mcpServerUpdateSchema — partial keeps the same field contract", () => {
  it("accepts disabledTools alone (the only field present)", () => {
    expect(mcpServerUpdateSchema.safeParse({ disabledTools: ["echo"] }).success).toBe(true);
  });

  it("rejects disabledTools with the same limits", () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `tool_${i}`);
    expect(mcpServerUpdateSchema.safeParse({ disabledTools: tooMany }).success).toBe(false);
  });
});
