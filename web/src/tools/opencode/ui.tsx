import type { ReactNode } from "react";
import {
  useAuiState,
  useToolArgsStatus,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView, denialOf, textPreview } from "@/tools/filesystem/ui";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { patchToCodeDiffs } from "@/lib/patch-to-diffs";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { resultToLines } from "@/lib/terminal-lines";
import {
  normalizeOpenCodeArgs,
  normalizeOpenCodeResult,
  openCodePatchFromParts,
  parseOpenCodeWebSearchHits,
} from "./adapt";
import { WebSearch } from "@/components/assistant-ui/elements/web-search";
import { CheckCircle2, Circle } from "lucide-react";
import type { OpenCodeTodo } from "@/features/opencode/todoState";
import { QuestionFormCard } from "@/components/shared/QuestionFormCard";
import { useToolLinkedQuestion } from "@/features/opencode/toolLinkedQuestion";
import { toolsConfig } from "@/config/tools";

type AnyArgs = Record<string, unknown>;
type AnyProps = ToolCallMessagePartProps<AnyArgs, unknown>;

/**
 * Rich renderers for OpenCode's own tools.
 *
 * Built on `BackendToolView` — the existing shared shell that owns the card,
 * the approval gate, the collapsed decision rows and the status handling — so
 * these add no new card machinery. They are NOT built on the `*ToolUI`
 * wrappers in `tools/filesystem/ui.tsx`: each of those is a short wrapper that
 * hardcodes the title, the argument shape AND the result shape, and for an
 * OpenCode tool all three differ. Adapting one would mean overriding exactly
 * what it hardcodes, so the honest reuse boundary is the shell underneath.
 *
 * Every argument name these read is produced by `normalizeOpenCodeArgs`, which
 * documents where each name was verified.
 */

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

/** Monospace body for a plain-text tool result (OpenCode's result is a string). */
function TextBody({ text }: { text: string }) {
  if (!text.trim()) {
    return <span className="text-muted-foreground">{toolsConfig.copy.status.noOutput}</span>;
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground/90">
      {textPreview(text)}
    </pre>
  );
}

interface OpenCodeViewSpec {
  /** OpenCode tool name — also the key used to look up the arg aliases. */
  tool: string;
  /** Card title, built from the NORMALIZED args. */
  title: (args: AnyArgs) => string;
  /** Requested path, for the outside-workspace pre-check on the approval gate. */
  targetPath?: (args: AnyArgs) => string;
  /** What the approval card shows as the thing being approved. */
  argPreview?: (args: AnyArgs) => ReactNode;
  runningLabel: string;
  /** Render the (string) result body, optionally with invocation args. */
  summarize: (result: unknown, args?: AnyArgs) => ReactNode;
  /** Presentation variant: standard full card or lightweight compact row. */
  variant?: "card" | "compact";
}

/**
 * Bind one OpenCode tool to the shared shell.
 *
 * Normalization happens exactly once, here, so every mapped tool gets it and
 * no renderer has to remember to ask for it.
 *
 * Every renderer this produces routes its approval state through
 * `BackendToolView` — the single dispatcher that reaches `ApprovalGate`, which
 * carries the stale-permission guard. Nothing here answers a gate itself, so
 * there is no second approval path to fall out of step.
 */
function openCodeView(spec: OpenCodeViewSpec): ToolCallMessagePartComponent {
  const View = (p: AnyProps) => {
    const args = normalizeOpenCodeArgs(spec.tool, p.args) ?? {};
    return (
      <BackendToolView
        title={spec.title(args)}
        args={args}
        {...(spec.argPreview ? { argPreview: spec.argPreview(args) } : {})}
        result={p.result}
        status={p.status}
        approval={p.approval}
        respondToApproval={p.respondToApproval}
        runningLabel={spec.runningLabel}
        summarize={(res, a) => spec.summarize(res, a ?? args)}
        tool={spec.tool}
        {...(spec.targetPath ? { targetPath: spec.targetPath(args) } : {})}
        {...(spec.variant ? { variant: spec.variant } : {})}
      />
    );
  };
  View.displayName = `OpenCodeToolUI(${spec.tool})`;
  return View as ToolCallMessagePartComponent;
}

const body = (result: unknown) => (
  <TextBody text={typeof result === "string" ? result : ""} />
);

/**
 * `read` — OpenCode args are `{ filePath, offset?, limit? }`; our rich UI's
 * `path` comes from the alias table. The result is the file text as a string.
 */
export const OpenCodeReadToolUI = openCodeView({
  tool: "read",
  title: (args) => `read · ${str(args.path)}`,
  targetPath: (args) => str(args.path),
  runningLabel: toolsConfig.copy.running.reading,
  summarize: body,
});

/**
 * `glob` — OpenCode args are `{ pattern, path? }`. The title uses `pattern`
 * aliased to `query`, matching how our own search tool titles itself.
 */
export const OpenCodeGlobToolUI = openCodeView({
  tool: "glob",
  title: (args) => `glob · ${str(args.query)}`,
  targetPath: (args) => str(args.path, "."),
  runningLabel: toolsConfig.copy.running.findingFiles,
  summarize: body,
});

/** `grep` — OpenCode args are `{ pattern, path?, include? }`. */
export const OpenCodeGrepToolUI = openCodeView({
  tool: "grep",
  title: (args) => `grep · ${str(args.query)}`,
  targetPath: (args) => str(args.path, "."),
  runningLabel: toolsConfig.copy.running.searching,
  summarize: body,
});

/* -------------------------------------------------------------------------
 * Permission-gated tools.
 *
 * These are the tools that actually hit the approval gate in Code mode — the
 * deployment's rules end with a catch-all `{"permission":"*","action":"ask"}`,
 * so most tool calls are gated. They are mapped here only because Phase 3A put
 * the stale-permission guard on `ApprovalGate`, which is the gate
 * `BackendToolView` reaches; a rich UI without it is the original wedge.
 *
 * Every view below therefore delegates its approval state to `BackendToolView`
 * and answers no gate itself — one guarded lifecycle, not two.
 * ---------------------------------------------------------------------- */

/** Preview of a whole-file write, mirroring the native writer's shape. */
const contentPreview = (args: AnyArgs) => (
  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
    {typeof args.content === "string" ? textPreview(args.content) : ""}
  </pre>
);

/** Preview of an exact-string edit: what is replaced, and with what. */
const editPreview = (args: AnyArgs) => (
  <div className="space-y-1 text-xs">
    <div className="text-muted-foreground">Find:</div>
    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
      {typeof args.oldText === "string" ? textPreview(args.oldText, 500) : ""}
    </pre>
    <div className="text-muted-foreground">Replace with:</div>
    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
      {typeof args.newText === "string" ? textPreview(args.newText, 500) : ""}
    </pre>
  </div>
);

/**
 * `edit` — the completed body is a DIFF, not the result string.
 *
 * OpenCode's `edit` result is the literal string "Edit applied successfully.";
 * the actual patch lives in the part's `metadata` (see
 * `openCodePatchFromParts`). A diff is what a reader needs to review an edit, so
 * when the patch is reachable it replaces the string entirely. The approval gate
 * is unaffected — it renders `argPreview` (the find/replace pair), because
 * `BackendToolView` only reaches `summarize` once the part is decided.
 *
 * Pure on purpose: the patch arrives as a PROP so this stays renderable in a
 * unit test, where there is no `AuiProvider` — and `useAuiState` throws without
 * one ("requires an AuiProvider"), which would take the whole render down.
 * `OpenCodeEditToolUI` below is the thin, provider-aware wrapper.
 */
export const OpenCodeEditView = ({
  diffPatch,
  ...p
}: AnyProps & { diffPatch?: string | null }) => {
  const args = normalizeOpenCodeArgs("edit", p.args) ?? {};
  return (
    <BackendToolView
      title={`edit · ${str(args.path)}`}
      args={args}
      argPreview={editPreview(args)}
      result={p.result}
      status={p.status}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.editing}
      summarize={() => {
        // Same shared conversion as the chat's ```diff fences, so an OpenCode
        // patch and a model-written patch render identically.
        const files = diffPatch ? patchToCodeDiffs(diffPatch) : [];
        if (files.length === 0) {
          // No reachable patch (a `write` part has none by data — see
          // `openCodePatchFromParts`), or nothing parseable: show what OpenCode
          // actually returned rather than an empty card.
          return <TextBody text={typeof p.result === "string" ? p.result : ""} />;
        }
        return (
          <div className="w-full space-y-2">
            {files.map((file, index) => (
              <CodeDiff
                key={`${index}-${file.filename}`}
                // Falls back to the path the model asked to edit, which is a
                // real argument — never an invented name.
                filename={file.filename || str(args.path)}
                additions={file.additions}
                deletions={file.deletions}
                lines={file.lines}
                cycle={0}
              />
            ))}
          </div>
        );
      }}
      tool="edit"
      targetPath={str(args.path)}
    />
  );
};
OpenCodeEditView.displayName = "OpenCodeEditView";

/**
 * Read the patch OpenCode recorded for this tool call.
 *
 * `state.metadata` is dropped by the runtime projection, but the untouched parts
 * survive as message metadata (`metadata.custom.opencode.parts`) — the same
 * reach `ChatWindow` already uses for its provenance chips. Returns null
 * whenever the patch is absent, which includes every `write` part (a whole-file
 * write has nothing to diff against) and every not-yet-completed part.
 */
function useOpenCodeEditPatch(callId: string | undefined): string | null {
  const rawParts = useAuiState(
    (s) =>
      (
        s.message.metadata?.custom as
          | { opencode?: { parts?: unknown } }
          | undefined
      )?.opencode?.parts,
  );
  return openCodePatchFromParts(rawParts, callId);
}

/** `edit` — OpenCode args are `{ filePath, oldString, newString, replaceAll }`. */
export const OpenCodeEditToolUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => {
  const diffPatch = useOpenCodeEditPatch(p.toolCallId);
  return <OpenCodeEditView {...p} diffPatch={diffPatch} />;
};
OpenCodeEditToolUI.displayName = "OpenCodeToolUI(edit)";

/** `write` — OpenCode args are `{ content, filePath }`. */
export const OpenCodeWriteToolUI = openCodeView({
  tool: "write",
  title: (args) => `write · ${str(args.path)}`,
  targetPath: (args) => str(args.path),
  argPreview: contentPreview,
  runningLabel: toolsConfig.copy.running.writing,
  summarize: body,
});

/**
 * `bash` — OpenCode args are `{ command, timeout?, workdir? }`.
 *
 * Completed output renders in the official `TerminalBlock` (the same component
 * the native `run_command` renderer uses), which is the "terminal output" the
 * Code-mode report asked for. Every other state — the approval gate, a closed
 * gate, denial, failure, still-running — delegates to `BackendToolView`, so the
 * gate keeps the one guarded lifecycle and this adds no second path.
 *
 * Deliberately NOT built on `RunCommandTerminalUI`: that renderer hardcodes its
 * title to `run_command`, which would mislabel an OpenCode `bash` call in the
 * very card the user reads to decide whether to allow it.
 */
export const OpenCodeBashToolUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => {
  const args = normalizeOpenCodeArgs("bash", p.args) ?? {};
  const command = str(args.command);
  // `resultToLines` dereferences its argument, so an absent result (a part that
  // is still running, or one with no output at all) must be handled here.
  const shaped = normalizeOpenCodeResult("bash", p.result);
  const lines = shaped == null ? [] : resultToLines(shaped as { stdout?: unknown });

  // The gate owns the card in every state it renders, so the terminal may only
  // appear once the gate has nothing left to say. This mirrors the gate's own
  // condition verbatim — `ApprovalGate` branches on `approval.approved ===
  // undefined` (filesystem/ui.tsx:472) and covers both "awaiting an answer" and
  // "the request is gone" (`resolution` set → ClosedGateMessage). Narrowing this
  // to only the awaiting case would let a closed gate's message be replaced by
  // stale output.
  const gateOwnsCard = p.approval != null && p.approval.approved === undefined;

  if (!gateOwnsCard && p.status?.type !== "incomplete" && lines.length > 0) {
    return (
      <div className="my-1 w-full">
        <TerminalBlock
          command={command}
          lines={lines}
          visibleCount={lines.length}
          done={p.status?.type !== "running"}
          variant="ink"
        />
      </div>
    );
  }

  return (
    <BackendToolView
      title={`bash · ${command}`}
      args={args}
      result={p.result}
      status={p.status}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.running}
      summarize={body}
      tool="bash"
      targetPath={str(args.cwd, ".")}
    />
  );
};
OpenCodeBashToolUI.displayName = "OpenCodeToolUI(bash)";

/* -------------------------------------------------------------------------
 * The remaining OpenCode tools.
 *
 * Every argument name below was read from the running server, never assumed:
 * `GET /experimental/tool?provider=<p>&model=<m>` returns each tool's JSON
 * schema, and these are its `required` fields. They are NOT permission-gated,
 * so they render inline rather than standalone.
 *
 * They are registered at all for two reasons. A registered renderer keeps the
 * card readable instead of dumping raw JSON, and — for `question` — it keeps
 * the part away from `ToolFallback`, whose approval card answers through
 * `addResult`, which this runtime does not implement ("Runtime does not support
 * tool results"). An unregistered `question` call therefore threw the moment a
 * reader touched it.
 * ---------------------------------------------------------------------- */

/** `task` — required `{ description, prompt, subagent_type }` (+ `task_id?`, `command?`). */
export const OpenCodeTaskToolUI = openCodeView({
  tool: "task",
  title: (args) => `task · ${str(args.subagent_type, "subagent")}`,
  argPreview: (args) => <TextBody text={str(args.prompt)} />,
  runningLabel: toolsConfig.copy.running.runningSubagent,
  summarize: body,
});

/** Parses raw args.todos into typed OpenCodeTodo items. */
function asTodoList(todos: unknown): OpenCodeTodo[] {
  if (!Array.isArray(todos)) return [];
  const result: OpenCodeTodo[] = [];
  for (const item of todos) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const content = typeof obj.content === "string" ? obj.content : "";
      if (!content.trim()) continue;
      const rawStatus = typeof obj.status === "string" ? obj.status : "pending";
      const status: OpenCodeTodo["status"] =
        rawStatus === "in_progress" ||
        rawStatus === "completed" ||
        rawStatus === "cancelled"
          ? rawStatus
          : "pending";
      const rawPriority = typeof obj.priority === "string" ? obj.priority : "medium";
      const priority: OpenCodeTodo["priority"] =
        rawPriority === "high" || rawPriority === "low" ? rawPriority : "medium";
      result.push({ content, status, priority });
    }
  }
  return result;
}

/** `todowrite` — compact historical invocation snapshot from args.todos. */
export const OpenCodeTodoWriteToolUI = openCodeView({
  tool: "todowrite",
  title: (args) => {
    const list = asTodoList(args.todos);
    const completed = list.filter((t) => t.status === "completed").length;
    return list.length > 0
      ? `todowrite · ${completed}/${list.length} completed`
      : "todowrite · empty";
  },
  argPreview: (args) => {
    const list = asTodoList(args.todos);
    const completed = list.filter((t) => t.status === "completed").length;
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-0.5">
        <Circle className="size-3.5 text-muted-foreground/60 shrink-0" />
        <span>{toolsConfig.copy.running.updatingTaskList}</span>
        {list.length > 0 && (
          <span className="text-[11px] tabular-nums text-muted-foreground/70">
            ({completed}/{list.length} completed)
          </span>
        )}
      </div>
    );
  },
  runningLabel: toolsConfig.copy.running.updatingTaskList,
  variant: "compact",
  summarize: (result, args) => {
    const list = asTodoList(args?.todos);
    const completed = list.filter((t) => t.status === "completed").length;
    const note =
      typeof result === "string" && result.trim().length > 0
        ? result.trim()
        : toolsConfig.copy.status.taskListUpdated;
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium text-foreground">
          todowrite · {completed}/{list.length} completed
        </span>
        <span>·</span>
        <span>{note}</span>
      </div>
    );
  },
});

/** `webfetch` — required `{ url }` (+ `format?`, `timeout?`). */
export const OpenCodeWebFetchToolUI = openCodeView({
  tool: "webfetch",
  title: (args) => `webfetch · ${str(args.url)}`,
  runningLabel: toolsConfig.copy.running.fetching,
  summarize: body,
});

/**
 * `websearch` — required `{ query }` (+ `numResults?`, `type?`, `livecrawl?`, …).
 *
 * Rendered by the **official assistant-ui `WebSearch` element**. The verified
 * OpenCode payload (`parseOpenCodeWebSearchHits`) supplies real `title` +
 * `domain` per hit, so this is a mapping rather than a reimplementation — the
 * element stays provider-agnostic and knows nothing about OpenCode.
 *
 * Hand-written rather than built by `openCodeView` because the element's
 * `searching` prop must be true **while the call is still running**, and
 * `summarize` only ever sees a settled result. `bash` is hand-written for the
 * same kind of reason (it needs its own terminal branch).
 *
 * WHO OWNS THE CARD. The gate owns it only while the decision is **pending** —
 * not for the whole lifetime of the part. This deployment gates nearly every
 * tool (the catch-all `{"permission":"*","action":"ask"}` rule), so an
 * `approval != null` test would route every *approved* search to the fallback
 * and the element would never render at all. The four conditions below mirror
 * `BackendToolView`'s own branches, so no state it handles is lost:
 *
 *   1. `gateUndecided`        — awaiting an answer, or the request is gone
 *   2. `awaitingContinuation` — approved, but execution rides the next message
 *   3. `failed`               — cancelled / incomplete
 *   4. `denied`               — a denial, via the shared `denialOf` rule
 *
 * Otherwise the element renders. The raw result stays visible beneath it on
 * purpose: the element shows only `title` + `domain`, while the payload also
 * carries `url` and `excerpts`, and discarding those to fit the element would
 * lose real information.
 */
export const OpenCodeWebSearchToolUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => {
  // Unconditional, as hook order requires. `propStatus.query` is
  // `"streaming" | "complete" | undefined`, and `undefined` is the ordinary
  // "already complete" case — so only an explicit `"streaming"` holds the
  // placeholder. Without it the pill shows a half-written query while the
  // model is still emitting the tool call.
  const { propStatus } = useToolArgsStatus<{ query: string }>();
  const args = normalizeOpenCodeArgs("websearch", p.args) ?? {};
  const query = propStatus.query === "streaming" ? toolsConfig.copy.running.searching : str(args.query);
  const hits = parseOpenCodeWebSearchHits(p.result);
  const raw = typeof p.result === "string" ? p.result : "";

  const gateUndecided = p.approval != null && p.approval.approved === undefined;
  const awaitingContinuation =
    p.approval?.approved === true &&
    p.result === undefined &&
    p.status?.type !== "running";
  const failed = p.status?.type === "incomplete";
  const denied = denialOf(p.result, p.approval) != null;

  if (!gateUndecided && !awaitingContinuation && !failed && !denied) {
    return (
      <div className="my-1 w-full space-y-2">
        <WebSearch
          query={query}
          // `null` means "not the verified shape" — the element still renders
          // its query and status, with no result rows and nothing invented.
          results={hits ?? []}
          visibleResults={hits?.length ?? 0}
          searching={p.status?.type === "running"}
          cycle={0}
        />
        {raw ? <TextBody text={raw} /> : null}
      </div>
    );
  }

  return (
    <BackendToolView
      title={`websearch · ${str(args.query)}`}
      args={args}
      result={p.result}
      status={p.status}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.searchingWeb}
      summarize={body}
      tool="websearch"
    />
  );
};
OpenCodeWebSearchToolUI.displayName = "OpenCodeToolUI(websearch)";

/** `skill` — required `{ name }`. */
export const OpenCodeSkillToolUI = openCodeView({
  tool: "skill",
  title: (args) => `skill · ${str(args.name)}`,
  runningLabel: toolsConfig.copy.running.loadingSkill,
  summarize: body,
});

/** Reads one question entry as a plain object, or `undefined`. */
function asQuestion(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Every question an OpenCode `question` call asked, in order. */
function questionList(args: AnyArgs): Record<string, unknown>[] {
  const list = args.questions;
  if (!Array.isArray(list)) return [];
  return list.map(asQuestion).filter((q): q is Record<string, unknown> => q !== undefined);
}

/**
 * `question` — required `{ questions }`.
 *
 * Two mounts, one UI. When the adapter holds a pending question linked to
 * this tool call (`request.tool.callID === toolCallId`), the shared
 * `QuestionFormCard` renders inline and answers through the capability
 * (`replyToQuestion` / `rejectQuestion`) — never `addResult`, which the
 * runtime rejects for tool parts. Otherwise the read-only preview below
 * shows what is being asked; the fallback panel (`OpenCodeQuestions`) owns
 * answering it. This renderer imports no adapter module: the link/answer
 * capability lives in `features/opencode` per the isolation boundary.
 */
export const QuestionReadonlyView = openCodeView({
  tool: "question",
  title: (args) => {
    const first = questionList(args)[0];
    return `question · ${str(first?.header) || str(first?.question) || "asked"}`;
  },
  argPreview: (args) => {
    const questions = questionList(args);
    if (questions.length === 0) {
      return <span className="text-muted-foreground">{toolsConfig.copy.status.noQuestionText}</span>;
    }
    return (
      <div className="space-y-3">
        {questions.map((q, i) => {
          const options = Array.isArray(q.options) ? q.options : [];
          return (
            <div key={i}>
              {typeof q.header === "string" && q.header ? (
                <p className="text-xs font-medium text-muted-foreground">{q.header}</p>
              ) : null}
              <p className="text-foreground">{str(q.question)}</p>
              {options.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {options.map((option, j) => {
                    const opt = asQuestion(option);
                    return (
                      <li key={j}>
                        · {str(opt?.label)}
                        {opt?.description ? ` — ${str(opt.description)}` : ""}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {toolsConfig.copy.status.answerOnCardAbove}
        </p>
      </div>
    );
  },
  runningLabel: toolsConfig.copy.running.waitingForAnswer,
  summarize: body,
});

export const OpenCodeQuestionToolUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => {
  const linked = useToolLinkedQuestion(p.toolCallId);
  if (linked) {
    const { request, answer, skip } = linked;
    return (
      <QuestionFormCard
        questions={request.questions}
        onSubmit={(answers) => answer(answers)}
        onDismiss={() => skip()}
      />
    );
  }
  return <QuestionReadonlyView {...p} />;
};
