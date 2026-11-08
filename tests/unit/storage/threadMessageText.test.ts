import { describe, it, expect } from "bun:test";
import { threadMessageText } from "@/services/storage/messages";

describe("threadMessageText extraction", () => {
  it("extracts text from AI SDK v7 parts array", () => {
    const message = {
      role: "user",
      parts: [{ type: "text", text: "Create a fast sorting algorithm" }],
    };
    expect(threadMessageText(message)).toBe("Create a fast sorting algorithm");
  });

  it("strictly excludes tool, reasoning, file, and other non-text parts", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Thinking about quicksort..." },
        { type: "tool-call", toolName: "bash", args: { command: "ls" } },
        { type: "dynamic-tool", name: "calculator", input: { a: 1 } },
        { type: "image", image: "base64..." },
        { type: "file", data: "..." },
        { type: "source-url", url: "https://example.com" },
        { type: "source-document", title: "Doc" },
        { type: "text", text: "Here is the implementation of quicksort." },
      ],
    };
    expect(threadMessageText(message)).toBe("Here is the implementation of quicksort.");
  });

  it("joins multiple text parts with a single space", () => {
    const message = {
      role: "user",
      parts: [
        { type: "text", text: "Hello" },
        { type: "text", text: "world" },
      ],
    };
    expect(threadMessageText(message)).toBe("Hello world");
  });

  it("falls back to legacy content array if parts is absent", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Legacy array content" },
        { type: "tool_use", id: "123" },
      ],
    };
    expect(threadMessageText(message)).toBe("Legacy array content");
  });

  it("falls back to legacy content string if parts is absent", () => {
    const message = {
      role: "user",
      content: "Legacy string content",
    };
    expect(threadMessageText(message)).toBe("Legacy string content");
  });

  it("handles legacy message direct array format", () => {
    const message = [{ type: "text", text: "Direct array item" }];
    expect(threadMessageText(message)).toBe("Direct array item");
  });

  it("returns empty string for null, undefined, or empty parts", () => {
    expect(threadMessageText(null)).toBe("");
    expect(threadMessageText(undefined)).toBe("");
    expect(threadMessageText({})).toBe("");
    expect(threadMessageText({ parts: [] })).toBe("");
  });
});
