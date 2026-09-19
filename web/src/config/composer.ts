/**
 * Single source of truth for composer menu copy (model / thinking / attach
 * pickers). Components reference this — no menu literals live in
 * `Composer.tsx`. Thinking level labels stay here (not in the store);
 * provider/model names come from settings data, never literals.
 */
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
    quickMessages: "Quick messages",
    quickMessagesEmpty: "No quick messages yet",
    quickMessagesLoading: "Loading...",
    quickMessageUntitled: "Untitled",
    clipboardWriteFailed: "Clipboard write failed — text kept in place",
  },
};
