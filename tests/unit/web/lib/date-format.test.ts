import { describe, it, expect } from "bun:test";
import { formatRelativeTime } from "@web/lib/date-format";

describe("formatRelativeTime", () => {
  it("handles null, undefined and invalid dates gracefully", () => {
    expect(formatRelativeTime(null)).toBe("");
    expect(formatRelativeTime(undefined)).toBe("");
    expect(formatRelativeTime("invalid-date")).toBe("");
  });

  it("formats recent timestamps as 'just now'", () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe("just now");
    expect(formatRelativeTime(new Date(now.getTime() - 30_000))).toBe("just now");
  });

  it("formats under 1 hour as narrow minutes", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinutesAgo)).toBe("5m ago");
  });

  it("formats under 24 hours as narrow hours", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toBe("2h ago");
  });

  it("formats between 24 and 48 hours as 'yesterday'", () => {
    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000);
    expect(formatRelativeTime(yesterday)).toBe("yesterday");
  });

  it("formats under 7 days as narrow days", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo)).toBe("3d ago");
  });

  it("formats older dates as localized short date", () => {
    const oldDate = new Date(2025, 0, 15);
    const result = formatRelativeTime(oldDate);
    expect(result).toMatch(/Jan\s+15/);
  });
});
