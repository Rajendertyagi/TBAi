/**
 * Single source of truth for TBAi-owned tool UI copy (running labels,
 * summary fallbacks, decision and empty states). Renderers reference this —
 * no application-owned UI literals live in individual tool renderers.
 *
 * Upstream/vendored assistant-ui elements (e.g. web-search.tsx) retain their
 * vendor-owned strings.
 */
export const toolsConfig = {
  copy: {
    running: {
      reading: "Reading…",
      listing: "Listing…",
      searching: "Searching…",
      writing: "Writing…",
      editing: "Editing…",
      deleting: "Deleting…",
      running: "Running…",
      working: "Working…",
      browsing: "Browsing…",
      acting: "Acting…",
      listingProcesses: "Listing processes…",
      stoppingProcess: "Stopping process…",
      readingSystemInfo: "Reading system info…",
      updatingList: "Updating list…",
      findingFiles: "Finding files…",
      runningSubagent: "Running subagent…",
      updatingTaskList: "Updating task list…",
      fetching: "Fetching…",
      searchingWeb: "Searching the web…",
      loadingSkill: "Loading skill…",
      waitingForAnswer: "Waiting for your answer…",
      approvedExecuting: "Approved — executing…",
    },
    status: {
      noOutput: "No output.",
      // Was a literal in the legacy `DiffViewer`; carried over so the migrated
      // diff rendering keeps the same empty state without a new hardcoded string.
      noDiffContent: "No diff content provided",
      emptyFolder: "Empty folder.",
      noProcesses: "No processes.",
      noItems: "No items.",
      noMatchesInFiles: (count: number) => `No matches in ${count} files.`,
      moreMatchesOmitted: "…more matches omitted",
      andMoreCount: (count: number) => `…and ${count} more`,
      approvedWillExecute:
        "Approved — will execute with your next message in this conversation.",
      cancelledBeforeCompletion: "Cancelled before completion.",
      failedWithReason: (reason: string) => `Failed: ${reason}`,
      deniedWithReason: (reason: string) => `Denied: ${reason}`,
      closedGate: (resolution: string) =>
        `Approval ${resolution} before a decision — run the request again if still needed.`,
      screenshotSaved: "Screenshot saved",
      screenshotFailed: "Screenshot failed",
      taskListUpdated: "Task list updated.",
      noQuestionText: "No question text.",
      answerOnCardAbove: "Answer it on the question card above.",
    },
  },
};
