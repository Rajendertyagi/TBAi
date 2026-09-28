/**
 * Single source of truth for composer menu copy (model / thinking / attach
 * pickers). Components reference this — no menu literals live in
 * `Composer.tsx`. Thinking level labels stay here (not in the store);
 * provider/model names come from settings data, never literals.
 */
import type { StreamRecoveryReason } from "@/features/chat/state/streamRecovery";

export const composerConfig = {
  copy: {
    selectModel: "Select model",
    noModels: "No models configured",
    defaultSuffix: "default",
    nextMessage: (provider: string, model: string) =>
      `Next message: ${provider} · ${model}`,
    thinking: "Thinking",
    /**
     * `Off` is a real, selectable level — not a "default" placeholder. The
     * effective level is always one of these four, so the chip can always name
     * it; calling the off state "Default" hid the fact that no thinking would
     * happen at all.
     */
    thinkingOff: "Off",
    thinkingLow: "Low",
    thinkingMedium: "Medium",
    thinkingHigh: "High",
    attach: "Attach",
    addImage: "Add Image",
    addFile: "Add File",
    addGithub: "Add GitHub PR / Issue",
    sendMessage: "Send message",
    stopGenerating: "Stop generating",
    // Offline send gate (Phase 3.7): the draft is retained, nothing is sent
    // or queued, and the user must explicitly send after recovery.
    sendOffline: "Backend unavailable — draft kept",
    sendOfflineTitle: "Backend unavailable. Your draft is kept — send it after reconnect.",
    modelSearchPlaceholder: "Search models...",
    modelSearchAria: "Search models",
    modelListAria: "Models",
    modelEmpty: "No models match your search",
    cut: "Cut",
    copy: "Copy",
    pasteAsPlainText: "Paste as plain text",
    selectAll: "Select all",
    /**
     * Header for the optional spelling block. It is a disabled item rather
     * than a submenu, because a submenu would add a hover-and-wait step
     * between right-clicking a typo and fixing it.
     */
    spellingSuggestions: "Spelling suggestions",
    quickMessages: "Quick messages",
    quickMessagesEmpty: "No quick messages yet",
    quickMessagesLoading: "Loading...",
    quickMessageUntitled: "Untitled",
    clipboardWriteFailed: "Clipboard write failed — text kept in place",
    // Dead-run recovery (Phase 3). One sentence per honest outcome, chosen by the
    // server's durable verdict and never by matching an error string: the client
    // cannot see WHY a restored run failed, and claiming "the app restarted" on a
    // network blip would be a lie. `retry` renders the affordance; it is only
    // ever passed `true` for a run the server confirmed as `interrupted`, which
    // is the one terminal kind a live send can never produce.
    //
    // Every one of these is shown ONLY when a finished run has no reply in the
    // conversation. A healthy thread shows nothing at all.
    streamInterrupted:
      "The app restarted while this reply was streaming. Nothing was sent — retry?",
    /** The run finished but its answer is not in the conversation. */
    streamReplyLost: "This reply could not be recovered.",
    /** The request itself failed (provider, network, rate limit, unknown). */
    streamRequestFailed: "The request failed.",
    /** The server classified the failure as an authentication failure. */
    streamAuthFailed:
      "Authentication failed for this provider. Check the API key in Settings, then try again.",
    /** The user stopped the run, or it was cut short deliberately. */
    streamCancelled: "This reply was cancelled.",
    streamRetry: "Retry",
    streamRetrying: "Retrying…",
  },
} as const;

/**
 * The one place a run-recovery reason becomes a sentence.
 *
 * Kept beside the copy so a new reason cannot be added without its wording, and
 * so a component can never pick a string literal for a reason. Exhaustive by
 * construction: a new `StreamRecoveryReason` is a type error here, not a silent
 * fallthrough to something misleading.
 */
export function streamRecoveryCopy(reason: StreamRecoveryReason): string {
  switch (reason) {
    case "interrupted":
      return composerConfig.copy.streamInterrupted;
    case "reply_lost":
      return composerConfig.copy.streamReplyLost;
    case "request_failed":
      return composerConfig.copy.streamRequestFailed;
    case "auth_failed":
      return composerConfig.copy.streamAuthFailed;
    case "cancelled":
      return composerConfig.copy.streamCancelled;
  }
}
