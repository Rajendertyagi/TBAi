"use client";

import { streamRecoveryCopy, composerConfig } from "../../config/composer";
import type { StreamRecoveryState } from "../../features/chat/state/streamRecovery";

export interface ComposerAlertsProps {
  codeSendError: string | null;
  compactError: string | null;
  recovery: StreamRecoveryState | undefined;
  retrying: boolean;
  onRetry: () => void;
}

/**
 * Inline alert strips inside the Composer bottom flex row.
 * Must render a Fragment (<>...</>) with zero wrapper elements so that
 * the flex children layout of its parent (items-end justify-between) is preserved.
 *
 * NOTE: The compaction spinner (directCompacting) is intentionally NOT rendered here.
 * It sits on its own line above the button row to prevent shifting the chips on compaction.
 */
export function ComposerAlerts({
  codeSendError,
  compactError,
  recovery,
  retrying,
  onRetry,
}: ComposerAlertsProps) {
  return (
    <>
      {codeSendError && (
        <div className="px-3 pb-3" role="alert">
          <p className="text-xs text-destructive">
            Couldn&apos;t start the Code chat: {codeSendError} Your text is kept above.
          </p>
        </div>
      )}
      {compactError && (
        <div className="px-3 pb-3" role="alert">
          <p className="text-xs text-destructive">
            Couldn&apos;t compact the session: {compactError} Nothing was sent.
          </p>
        </div>
      )}
      {recovery && (
        <div className="px-3 pb-3" role="alert">
          <p className="text-xs text-destructive">
            {streamRecoveryCopy(recovery.reason)}
          </p>
          {recovery.canRetry && (
            <button
              type="button"
              className="mt-1 text-xs font-medium underline underline-offset-2"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? composerConfig.copy.streamRetrying : composerConfig.copy.streamRetry}
            </button>
          )}
        </div>
      )}
    </>
  );
}

