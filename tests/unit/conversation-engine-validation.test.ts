import { describe, it, expect } from "bun:test";
import {
  conversationCreateSchema,
  conversationUpdateSchema,
} from "../../src/lib/validation";

/**
 * Zod schemas for the dual-chat (P0b–P4) conversation fields: `engine`,
 * `opencodeAgent`, `opencodeModel`. Tests target the parse contract — valid
 * values, enum rejection, and length bounds — not schema internals.
 */

describe("conversationCreateSchema — engine / opencodeAgent / opencodeModel", () => {
  it("accepts valid engine values, agent and model strings (happy path)", () => {
    const parsed = conversationCreateSchema.parse({
      engine: "opencode",
      opencodeAgent: "coder",
      opencodeModel: "anthropic/claude-sonnet-4",
    });
    expect(parsed.engine).toBe("opencode");
    expect(parsed.opencodeAgent).toBe("coder");
    expect(parsed.opencodeModel).toBe("anthropic/claude-sonnet-4");
  });

  it("accepts omitted engine/agent/model and the explicit null sentinel", () => {
    const omitted = conversationCreateSchema.parse({});
    expect(omitted.engine).toBeUndefined();
    expect(omitted.opencodeAgent).toBeUndefined();
    expect(omitted.opencodeModel).toBeUndefined();

    const explicit = conversationCreateSchema.parse({
      engine: "direct",
      opencodeAgent: null,
      opencodeModel: null,
    });
    expect(explicit.engine).toBe("direct");
    expect(explicit.opencodeAgent).toBeNull();
    expect(explicit.opencodeModel).toBeNull();
  });

  it("rejects an invalid engine enum value (edge case)", () => {
    const result = conversationCreateSchema.safeParse({ engine: "magical" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["engine"]);
    }
  });

  it("rejects overlong opencodeAgent / opencodeModel (edge case: > 200 chars)", () => {
    const long = "x".repeat(201);
    expect(conversationCreateSchema.safeParse({ opencodeAgent: long }).success).toBe(false);
    expect(conversationCreateSchema.safeParse({ opencodeModel: long }).success).toBe(false);
    // Boundary: exactly 200 chars is valid.
    const atLimit = "x".repeat(200);
    expect(conversationCreateSchema.safeParse({ opencodeAgent: atLimit }).success).toBe(true);
    // Empty string violates min(1).
    expect(conversationCreateSchema.safeParse({ opencodeAgent: "" }).success).toBe(false);
  });
});

describe("conversationUpdateSchema — engine / opencodeAgent / opencodeModel", () => {
  it("accepts a partial update carrying the new fields (happy path)", () => {
    const parsed = conversationUpdateSchema.parse({
      engine: "opencode",
      opencodeAgent: "planner",
      opencodeModel: "openai/gpt-4o",
    });
    expect(parsed.engine).toBe("opencode");
    expect(parsed.opencodeAgent).toBe("planner");
    expect(parsed.opencodeModel).toBe("openai/gpt-4o");
  });

  it("rejects an invalid engine enum value on update (edge case)", () => {
    const result = conversationUpdateSchema.safeParse({ engine: "bogus" });
    expect(result.success).toBe(false);
  });

  it("rejects overlong agent/model and allows the 200-char boundary", () => {
    const long = "y".repeat(201);
    expect(conversationUpdateSchema.safeParse({ opencodeAgent: long }).success).toBe(false);
    expect(conversationUpdateSchema.safeParse({ opencodeModel: long }).success).toBe(false);
    const atLimit = "y".repeat(200);
    expect(conversationUpdateSchema.safeParse({ opencodeModel: atLimit }).success).toBe(true);
  });
});
