/**
 * Single source of truth for TBAi-owned tool UI copy (running labels,
 * summary fallbacks, decision and empty states) and for the render budgets the
 * tool cards are held to. Renderers reference this — no application-owned UI
 * literals and no inline cap numbers live in individual tool renderers.
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
      /**
       * A tool that succeeded and produced nothing. ONLY for a result that is
       * genuinely empty — see `status.resultUnreadable` for the case this must
       * not be used for.
       */
      noOutput: "No output.",
      /**
       * A result that EXISTS but that the renderer could not read into text —
       * a content array whose parts are not text/file, or a structured payload
       * with no text field. Deliberately distinct from `noOutput`: the tool ran
       * and said something, so "No output." would be a lie about the tool and a
       * silent failure about the card. An empty string and an empty content
       * array are NOT this case — those are genuinely empty.
       */
      resultUnreadable: "The tool returned a result this card could not display.",
      /**
       * A part the runtime marked as an error whose result carries no readable
       * reason (no `error` string). The failure is real — `isError` is the
       * runtime's own verdict — so the card must say so rather than fall
       * through to a body that reads as success.
       */
      failedWithoutReason: "Failed — the tool reported an error with no reason.",
      // Was a literal in the legacy `DiffViewer`; carried over so the migrated
      // diff rendering keeps the same empty state without a new hardcoded string.
      noDiffContent: "No diff content provided",
      emptyFolder: "Empty folder.",
      noProcesses: "No processes.",
      noItems: "No items.",
      noMatchesInFiles: (count: number) => `No matches in ${count} files.`,
      moreMatchesOmitted: "…more matches omitted",
      diffRowsOmitted: (count: number) => `…${count} more diff lines omitted`,
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
      /**
       * The `question` tool card is a READ-ONLY history record — it never hosts
       * a control. The live question is answered in the dock directly above the
       * composer (`OpenCodeQuestions`), and the answer comes back on this card
       * once the part completes. So the caption points at the dock, and the
       * options are deliberately NOT printed here while it is open: listing
       * them on a surface that cannot accept a click is what made this card a
       * dead end.
       */
      answerInQuestionDock: "Answer this in the question box just above the text field.",
      /**
       * A question that will never be answered: dismissed, or it failed. The
       * server reports both the same way, so this says only what is true of
       * either — the dock it would otherwise point at is never coming back.
       */
      questionClosedNoAnswer: "Closed without an answer.",
      /** The answered value, shown on the card once the question settles. */
      yourAnswer: "Your answer",
    },
    /**
     * Copy for the native OpenCode V2 form card (`V2FormCard`). It is a
     * TBAi-owned tool surface like any other, so its labels live here rather
     * than as literals in the component.
     */
    form: {
      selectPrompt: "Select…",
      trueLabel: "True",
      falseLabel: "False",
      externalField: "This field must be completed in OpenCode.",
      /** Marks a required field in its label. */
      requiredMarker: "*",
      /**
       * The row that reveals a free-text answer. It is added BESIDE a field's
       * options whenever the server says the field accepts its own value — it
       * never replaces the options. See `V2OptionControl`.
       */
      other: "Other…",
      /** Placeholder for a question that is answered only in free text. */
      yourAnswer: "Type your answer",
      /** Accessible name for the group of option rows. */
      optionGroupLabel: (title: string) => `${title} — choose one`,
      /** Label for the free-text control that sits BESIDE a field's options. */
      customEntryLabel: "Or type your own answer",
      customEntryPlaceholder: "Type a different answer",
      /** Adds one free-text entry to a multiselect that allows custom values. */
      customEntryAddHint: "Press Enter to add",
      addEntryLabel: "Add another option",
      submit: "Submit",
      submitting: "Submitting…",
      cancel: "Cancel",
      invalidForm: "Invalid form",
      submitFailed: "Could not submit form",
      /** Progress through a multi-question form, e.g. "1 of 3". */
      progress: (current: number, total: number) => `${current} of ${total}`,
      /** How many further forms are waiting behind this one. */
      queued: (count: number) => `${count} more waiting`,
      /** Accessible name for the row of step dots. */
      stepsLabel: "Questions",
      /** Accessible name for one step dot. */
      stepAria: (index: number) => `Question ${index}`,
      back: "Back",
      /** Steps forward to the next question. Submit replaces it on the last. */
      next: "Next",
      /** Shown when a form asks nothing: every field is hidden or none exist. */
      nothingToAsk: "There is nothing to answer here.",
      cancelFailed: "Could not dismiss this question",
      expand: "Show the question",
      collapse: "Hide the question",

      /* --------------------------------------------------------------------
       * Copying a pending question out of the dock, so it can be answered
       * somewhere else — another tool, a script, a colleague.
       *
       * Every copy of a question DROPS the routing ids (`id`, `sessionID`,
       * `metadata`): they address one question inside one session on this
       * machine, and a copy carrying them is not portable. The stripping lives
       * in `questionSerializers.ts`; these are only the words and the dwell
       * time the dock needs to report what happened.
       * ------------------------------------------------------------------ */

      /** Accessible name for the Markdown copy action. */
      copyMarkdown: "Copy as Markdown",
      /** Accessible name for the JSON copy action. */
      copyJson: "Copy as JSON",
      /** Reported after the browser confirmed the Markdown write. */
      copiedMarkdown: "Markdown copied.",
      /** Reported after the browser confirmed the JSON write. */
      copiedJson: "JSON copied.",
      /** The browser HAS a clipboard and refused this write. */
      copyRefused: "The browser refused the copy. Allow clipboard access, then try again.",
      /** There is no clipboard to call at all (insecure context, or unsupported). */
      copyUnavailable: "This browser will not let the page copy. Copy is unavailable here.",
      /** The question asked nothing visible, so there was nothing to copy. */
      copyEmpty: "This question has nothing to copy.",
      /** Marks a required question in copied Markdown. */
      copyRequired: "(required)",
      /** What a question with no options expects, in copied Markdown. */
      copyAnswerText: "Answer with text.",
      copyAnswerNumber: "Answer with a number.",
      copyAnswerInteger: "Answer with a whole number.",
      copyAnswerList: "Answer with one or more values.",
    },
    /**
     * Per-card captions. `searchedVia` labels a web-search card with the engine
     * that answered, taken verbatim from `state.metadata.provider` — a
     * function, not a template, so the renderer interpolates a real value and
     * never a placeholder. Not under `running`/`status` because it describes
     * neither: it is provenance for an already-settled result.
     */
    webSearch: {
      searchedVia: (provider: string) => `Searched via ${provider}`,
    },
  },

  /**
   * Render budgets for the tool cards. One home, so a cap is never tuned in two
   * files at once. Every bound is a *display* bound: the durable tool result
   * keeps the full payload either way.
   */
  /**
   * How long a transient message stays on screen before it clears itself.
   *
   * Durations live here rather than in a copy bucket, because a number among a
   * set of strings reads as a mistake even when it is deliberate — and the next
   * person to add one would follow the odd precedent instead of the rule.
   */
  timing: {
    /**
     * How long a copy CONFIRMATION stays before it clears. Failures deliberately
     * do NOT expire: a message that has already vanished is indistinguishable
     * from a button that did nothing.
     */
    copyConfirmMs: 2400,
  },
  limits: {
    /**
     * Characters of ONE file's diff preview a card may paint. Ported from the
     * OpenChamber reference (`toolDiffPreview.ts`, `TOOL_DIFF_PREVIEW_MAX_CHARS`),
     * where it guards the payload its own comment describes: a few lines of
     * inlined base64 or a minified bundle — a line-count cap cannot see those.
     */
    diffPreviewMaxChars: 256 * 1024,
    /**
     * Rows of ONE file's diff preview a card may paint. Same value as the
     * terminal block's `TERMINAL_MAX_LINES` (both answer "how many rows may one
     * tool body paint"), kept as its own constant so the diff parser stays
     * independent of the terminal lib. Same reference file
     * (`TOOL_DIFF_PREVIEW_MAX_LINES`).
     */
    diffPreviewMaxLines: 2000,
    /**
     * Rows of ONE web-search result list the card may paint. The vendored
     * `WebSearch` element caps through its own `visibleResults` prop
     * (`take(results, visibleResults)`), so this feeds that mechanism instead of
     * inventing a second one — the element stays byte-identical to upstream.
     *
     * 5, because the element is a `max-w-sm` summary inside a chat timeline and
     * five rows (~140px) still read as a summary: the observed providers return
     * 7–10 hits, and a card that grows to ten rows stops being a card. The
     * count the reader is given is the real one (the element derives it from
     * `results.length`, not from the cap), and the full document stays visible
     * in the body beneath, so a display cap costs no data.
     */
    webSearchMaxResults: 5,
  },
};
