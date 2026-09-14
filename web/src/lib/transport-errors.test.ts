import { describe, it, expect } from "bun:test";
import { chatErrorCopy, classifyChatError } from "./transport-errors";

describe("classifyChatError", () => {
  it("maps raw transport kills", () => {
    const transport = [
      new TypeError("network error"),
      new TypeError("Failed to fetch"),
      new TypeError("terminated"),
      new TypeError("Connection reset by peer"),
      new TypeError("Connection refused"),
      new TypeError("Load failed"),
      new TypeError("Socket hang up"),
      new TypeError("socket error"),
      new TypeError("The operation timed out"),
      new TypeError("fetch timeout exceeded"),
      new DOMException("network error", "NetworkError"),
      "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
      "TypeError: network error",
    ];
    for (const e of transport) {
      expect(classifyChatError(e)).toBe("transport");
    }
  });

  it("maps TimeoutError (proxy/server too slow) as transport", () => {
    const e = new Error("The operation timed out");
    e.name = "TimeoutError";
    expect(classifyChatError(e)).toBe("transport");
  });

  it("never rewrites user cancel", () => {
    expect(classifyChatError(new DOMException("Aborted", "AbortError"))).toBe("other");
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyChatError(e)).toBe("other");
    expect(classifyChatError("Generation stopped.")).toBe("other");
  });

  it("never rewrites server copies or config errors", () => {
    const kept = [
      "Network error reaching the provider. Retry when online.",
      "Provider credentials invalid or missing. Check the provider API key.",
      "Provider rate limit reached. Wait briefly and retry.",
      "Generation failed. Retry or pick another provider/model.",
      "A tool call failed. See diagnostics and retry.",
      "No API key configured for this provider.",
      "Conversation not found",
      "stream unavailable",
      "An error occurred",
    ];
    for (const text of kept) {
      expect(classifyChatError(text)).toBe("other");
      expect(classifyChatError(new Error(text))).toBe("other");
    }
  });

  it("treats missing/foreign values as other", () => {
    expect(classifyChatError(undefined)).toBe("other");
    expect(classifyChatError(null)).toBe("other");
    expect(classifyChatError(500)).toBe("other");
    expect(classifyChatError({})).toBe("other");
  });

  it("renders the specified copy only for transport kills", () => {
    expect(chatErrorCopy("transport")).toBe(
      "Connection interrupted. The AI run could not be resumed.",
    );
    expect(chatErrorCopy("other")).toBeNull();
  });
});
