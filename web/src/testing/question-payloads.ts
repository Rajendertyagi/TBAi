/**
 * REAL OpenCode `question` tool payloads, captured and kept verbatim.
 *
 * WHY A SEPARATE FILE. `@/testing/websearch-payloads` exists for exactly the
 * same reason and the reason is worth repeating: a fixture invented to match a
 * guess cannot catch the guess being wrong. The question form rendered a blank
 * box and validated any string, and both faults came from reading the field
 * schema wrong — so the fixtures below are the server's own bytes, with the
 * endpoints and session they came from.
 *
 * WHERE THEY CAME FROM. The app's OpenCode server, `http://localhost:3001/api/
 * opencode` (the same process the browser talks to), on 2026-09-28:
 *
 *   1. `POST   /api/session`                      -> ses_f1b6d1559ffexqDInzHBa5uRG5
 *   2. `POST   /api/session/<id>/model`           -> agnes/agnes-3.0-flash
 *   3. `POST   /api/session/<id>/agent`           -> build
 *   4. `POST   /api/session/<id>/prompt`          -> "Ask me a question using the
 *                                                   question tool: which database
 *                                                   should I use, postgres or
 *                                                   sqlite?"
 *                                                   -> assistant part
 *                                                   `call_a95d7a43c1574559987ec06f`,
 *                                                   state.status = "running"
 *   5. `GET    /api/session/<id>/permission`      -> per_0e493c464001G26b4987SSdJsd
 *                                                   (action "question")
 *   6. `POST   /api/session/<id>/permission/<pid>/reply` { decision: "once" }
 *   7. `GET    /api/session/<id>/form`            -> frm_0e4940657001JDNPWj2eUCQn2Z
 *                                                   (see `capturedQuestionForm`)
 *   8. `POST   /api/session/<id>/form/<fid>/reply`{ answer: { q0: "Postgres" } }
 *   9. `GET    /api/session/<id>/form/<fid>`      -> state.status = "answered",
 *                                                   state.answer = { q0: "Postgres" }
 *  10. `GET    /api/session/<id>/message`         -> the tool part goes
 *                                                   `status: "completed"` and
 *                                                   gains `state.metadata`
 *                                                   (see `capturedQuestionPart`)
 *
 * THE FACT THIS FILE PROVES. Step 7 is the whole bug in one payload: the field
 * carries `options` AND `custom: true` TOGETHER. OpenAPI's
 * `Form.MultiselectField` shows what that means — there `options` is REQUIRED
 * and `custom` still exists — so `custom` is a free-text escape hatch ADDED to
 * an option list, not a switch that replaces it. The renderer gated its option
 * control on `options && !custom`, which is false for every real `question`
 * form, so the options were dropped; the validator skipped its option check on
 * the same condition, so any string passed.
 *
 * `throws` below are not behaviour the app invented: each was observed by
 * replying to a throwaway form on the same server (steps 7-8 repeated with
 * different `fields`), and the messages are the server's.
 */

/** Session the captures below came from. Named so a failure can be re-read. */
export const CAPTURED_QUESTION_SESSION_ID = "ses_f1b6d1559ffexqDInzHBa5uRG5";

/** The assistant-ui tool-call id the V2 projection derives for that part. */
export const CAPTURED_QUESTION_TOOL_PART_ID = "call_a95d7a43c1574559987ec06f";

/** The official V2 tool part id, which is the LAST `:`-segment of the call id. */
export const CAPTURED_QUESTION_PART_ID = CAPTURED_QUESTION_TOOL_PART_ID;

/**
 * Step 7 verbatim: the pending form the permission approval raised.
 *
 * `metadata.tool` is what links this form back to the tool call that asked the
 * question (`messageID` + `id`), which is how a `question` card and its form
 * are known to be the same request.
 */
export const capturedQuestionForm = {
  id: "frm_0e4940657001JDNPWj2eUCQn2Z",
  sessionID: CAPTURED_QUESTION_SESSION_ID,
  title: "Questions",
  metadata: {
    kind: "question",
    tool: {
      messageID: "msg_0e493baaf001A64CwYFNq1RGlF",
      id: CAPTURED_QUESTION_PART_ID,
    },
  },
  fields: [
    {
      key: "q0",
      title: "Database choice",
      description: "Which database should you use?",
      type: "string" as const,
      options: [
        {
          value: "SQLite",
          label: "SQLite",
          description: "SQLite — file-based, zero-config, ideal for a small app with minimal ops overhead",
        },
        {
          value: "Postgres",
          label: "Postgres",
          description: "Postgres — a full relational database server, better for multi-client or heavy workloads",
        },
      ],
      // The field that broke the renderer: present, and true, on the same field.
      custom: true,
    },
  ],
};

/** Step 9 verbatim: the same form after the reply was accepted. */
export const capturedAnsweredQuestionForm = {
  ...capturedQuestionForm,
  state: { status: "answered" as const, answer: { q0: "Postgres" } },
};

/**
 * Step 10 verbatim: the `question` tool part as the HISTORY read returns it
 * after completion — the shape a reloaded conversation renders from.
 *
 * This is the payload that makes the answer reachable without a live event:
 * `state.metadata.answers` is `[["Postgres"]]`, the outer array indexed by
 * question. The sibling `content` text is the server's own natural-language
 * echo of the same answer, kept because it is what the card's body shows.
 *
 * The em dash in each description arrived as U+2014; it is written here as the
 * same character, not a transliteration.
 */
export const capturedQuestionPart = {
  type: "tool",
  id: CAPTURED_QUESTION_PART_ID,
  name: "question",
  executed: false,
  state: {
    status: "completed" as const,
    input: {
      questions: [
        {
          header: "Database choice",
          options: [
            {
              description: "SQLite — file-based, zero-config, ideal for a small app with minimal ops overhead",
              label: "SQLite",
            },
            {
              description: "Postgres — a full relational database server, better for multi-client or heavy workloads",
              label: "Postgres",
            },
          ],
          question: "Which database should you use?",
        },
      ],
    },
    content: [
      {
        type: "text" as const,
        text:
          "User has answered your questions: \"Which database should you use?\"=\"Postgres\". You can now continue with the user's answers in mind.",
      },
    ],
    metadata: {
      answers: [["Postgres"]],
      truncated: false,
    },
  },
  time: { created: 1790541284374, ran: 1790541284442, completed: 1790541343168 },
};

/**
 * The `content` array of `capturedQuestionPart`, as the projection hands it to
 * a renderer (`v2History`/`v2Events` set it as the part's `output`, and the
 * message projection passes `output` through as `result`).
 */
export const capturedQuestionContent = capturedQuestionPart.state.content;

/**
 * The raw-parts array the projection puts on message metadata
 * (`metadata.custom.opencode.parts`), holding the captured part. What the
 * renderer reads the answer from.
 */
export const capturedQuestionRawParts = [capturedQuestionPart];

/**
 * A PENDING `question` part, from step 4: same call, still running, and
 * carrying no `answers`. The control for "the answer must not appear before
 * there is one".
 */
export const capturedPendingQuestionPart = {
  type: "tool",
  id: CAPTURED_QUESTION_PART_ID,
  name: "question",
  executed: false,
  state: {
    status: "running" as const,
    input: capturedQuestionPart.state.input,
    metadata: {},
  },
  time: { created: 1790541284374, ran: 1790541284442 },
};

/**
 * The option/custom verdicts, each observed by POSTing a reply to a throwaway
 * form on the same server. `throws` is the server's own message.
 *
 * These are the rules `validateField` implements, so a future change to it can
 * be checked against a fact rather than against a reading of the OpenAPI
 * document alone.
 */
export const capturedOptionVerdicts = {
  /** `{ options:[X,Y], custom:true }` + `"anything-goes"` -> accepted. */
  unlistedWithCustom: { accepted: true },
  /** `{ options:[X,Y] }` + `"nope"` -> rejected. */
  unlistedWithoutCustom: { accepted: false, throws: "Invalid option for form field: b" },
  /** `{ options:[] }` + `"free text"` -> rejected: an empty list is a closed set. */
  emptyOptionsWithoutCustom: { accepted: false, throws: "Invalid option for form field: c" },
  /** `{ options:[], custom:true }` + `"free text"` -> accepted. */
  emptyOptionsWithCustom: { accepted: true },
  /** `{ type:"multiselect", options:[X], custom:true }` + `["x","free1"]` -> accepted. */
  multiselectMixedWithCustom: { accepted: true },
  /** `{ type:"multiselect", options:[X] }` + `"x"` -> rejected: the answer is an array. */
  multiselectScalar: { accepted: false, throws: "Expected string array for form field: e" },
} as const;
