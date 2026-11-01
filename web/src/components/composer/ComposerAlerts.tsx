"use client";

import { streamRecoveryCopy, composerConfig } from "../../config/composer";
import type { StreamRecoveryState } from "../../features/chat/state/streamRecovery";
import { AlertCircle, RefreshCw } from "lucide-react";

export interface ComposerAlertsProps {
  codeSendError: string | null;
  compactError: string | null;
  recovery: StreamRecoveryState | undefined;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * Chat surface alert banners positioned above the composer input card.
 * Rendered outside ComposerPrimitive.Root so the composer input card's bounding box
 * does not deform or gain height when an error occurs.
 *
 * NOTE: For normal chat turn failures, `@assistant-ui`'s <AssistantError /> in the
 * transcript is the primary error owner (rendering details, error ref, and retry).
 * Recovery here is shown only when actionable (`recovery.canRetry`) or when an
 * interrupted dead-run recovery notice needs to be reported, preventing duplicate
 * error displays when a stream fails.
 */
export function ComposerAlerts({
  codeSendError,
  compactError,
  recovery,
  retrying,
  onRetry,
}: ComposerAlertsProps) {
  // Only show recovery if it is actionable (retryable) or represents an interrupted run.
  // Unrecoverable "request_failed" stream errors are already displayed by the assistant message error card.
  const showRecovery =
    recovery !== undefined && (recovery.canRetry || recovery.reason === "interrupted");

  if (!codeSendError && !compactError && !showRecovery) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 pb-2" data-testid="composer-alerts">
      {codeSendError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          <p className="flex-1">
            Couldn&apos;t start the Code chat: {codeSendError} Your text is kept below.
          </p>
        </div>
      )}
      {compactError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          <p className="flex-1">
            Couldn&apos;t compact the session: {compactError} Nothing was sent.
          </p>
        </div>
      )}
      {showRecovery && recovery && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="size-4 shrink-0" />
            <p className="truncate">{streamRecoveryCopy(recovery.reason)}</p>
          </div>
          {recovery.canRetry && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80 active:scale-95"
              onClick={onRetry}
              disabled={retrying}
            >
              <RefreshCw className={`size-3 ${retrying ? "animate-spin" : ""}`} />
              {retrying ? composerConfig.copy.streamRetrying : composerConfig.copy.streamRetry}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
