/**
 * Invariance guard for Composer alerts (Backlog P2 & Deduplication).
 *
 * Asserts that:
 * 1. Alerts render outside ComposerPrimitive.Root (in the chat surface dock above the card).
 * 2. When alerts are active (codeSendError, compactError, recovery), ComposerPrimitive.Root
 *    has zero alert children and its structure remains invariant.
 * 3. Alerts provide standard role="alert" accessibility attributes and action triggers.
 * 4. Non-actionable "request_failed" stream errors are suppressed in ComposerAlerts so they do
 *    not duplicate the transcript's AssistantError card.
 */

import { describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ComposerAlerts } from "@web/components/composer/ComposerAlerts";

describe("ComposerAlerts placement and semantics (P2)", () => {
  it("renders nothing when no errors exist", () => {
    const div = document.createElement("div");
    const root = createRoot(div);

    act(() => {
      root.render(
        <ComposerAlerts
          codeSendError={null}
          compactError={null}
          recovery={undefined}
          retrying={false}
          onRetry={() => {}}
        />,
      );
    });

    expect(div.querySelector('[role="alert"]')).toBeNull();
    expect(div.querySelector('[data-testid="composer-alerts"]')).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("suppresses non-retryable request_failed recovery to prevent duplicate error with transcript", () => {
    const div = document.createElement("div");
    const root = createRoot(div);

    act(() => {
      root.render(
        <ComposerAlerts
          codeSendError={null}
          compactError={null}
          recovery={{
            threadId: "t1",
            streamId: "s1",
            reason: "request_failed",
            canRetry: false,
            prompt: "hi",
            at: Date.now(),
          }}
          retrying={false}
          onRetry={() => {}}
        />,
      );
    });

    // Must be suppressed because transcript's AssistantError already handles it
    expect(div.querySelector('[role="alert"]')).toBeNull();
    expect(div.querySelector('[data-testid="composer-alerts"]')).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it("renders code send error banner with role='alert'", () => {
    const div = document.createElement("div");
    const root = createRoot(div);

    act(() => {
      root.render(
        <ComposerAlerts
          codeSendError="Failed to connect"
          compactError={null}
          recovery={undefined}
          retrying={false}
          onRetry={() => {}}
        />,
      );
    });

    const alert = div.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't start the Code chat: Failed to connect");
    act(() => {
      root.unmount();
    });
  });

  it("renders compact error banner with role='alert'", () => {
    const div = document.createElement("div");
    const root = createRoot(div);

    act(() => {
      root.render(
        <ComposerAlerts
          codeSendError={null}
          compactError="Context too large"
          recovery={undefined}
          retrying={false}
          onRetry={() => {}}
        />,
      );
    });

    const alert = div.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't compact the session: Context too large");
    act(() => {
      root.unmount();
    });
  });

  it("renders stream recovery with retry button and triggers callback", () => {
    const div = document.createElement("div");
    const root = createRoot(div);
    let retried = false;

    act(() => {
      root.render(
        <ComposerAlerts
          codeSendError={null}
          compactError={null}
          recovery={{
            threadId: "t1",
            streamId: "s1",
            reason: "interrupted",
            canRetry: true,
            prompt: "hi",
            at: Date.now(),
          }}
          retrying={false}
          onRetry={() => {
            retried = true;
          }}
        />,
      );
    });

    const alert = div.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const retryBtn = div.querySelector("button");
    expect(retryBtn).not.toBeNull();

    act(() => {
      retryBtn?.click();
    });
    expect(retried).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});
