import type { ReactNode } from "react";
import {
  useAuiState,
  useToolArgsStatus,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { BackendToolView, denialOf } from "@/tools/filesystem/ui";
import { textPreview } from "@/tools/text-preview";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { isUnifiedDiff, patchToCodeDiffs, type CodeDiffFile } from "@/lib/patch-to-diffs";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { resultToLines } from "@/lib/terminal-lines";
import {
  classifyOpenCodeResultBody,
  normalizeOpenCodeArgs,
  normalizeOpenCodeResult,
  openCodeResultText,
  openCodePatchFromParts,
  openCodeQuestionAnswersFromParts,
  openCodeWebSearchProviderFromParts,
  parseOpenCodeWebSearchHits,
} from "./adapt";
import { WebSearch } from "@/components/assistant-ui/elements/web-search";
import { CheckCircle2, Circle } from "lucide-react";
import type { OpenCodeTodo } from "@/features/opencode/v2Todos";
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

/**
 * The name a file inside a patch is shown and keyed by.
 *
 * `patchToCodeDiffs` emits ONE entry per file (it walks a file's chunks
 * internally), so the name IS the entry's identity and the array index it used
 * to be keyed by carried no information at all. A patch entry with no name falls
 * back to the path the model asked to edit, which is a real argument, never an
 * invented one; there is at most one such entry, so it cannot collide with a
 * sibling.
 *
 * One helper serves both the key and the `filename` prop because they must be
 * the same value: a key disagreeing with the visible name would be a second,
 * invisible identity for one card.
 */
export function patchFileName(filename: string, fallbackPath: string): string {
  return filename || fallbackPath;
}

/**
 * The stable identity of one question inside a single `question` call.
 *
 * The payload carries no per-question id, so the identity is the question
 * itself: its own text, qualified by the header above it, because two questions
 * under one header are ordinary while two carrying the same text are not.
 *
 * Exported so the choice is unit-tested. An index key here would re-attribute a
 * settled answer to whichever question moved into that slot.
 */
export function questionItemKey(header: string, question: string): string {
  return `${header}::${question}`;
}

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : value == null ? fallback : String(value);

/**
 * Monospace body for a tool result, told apart by what the result IS.
 *
 * The three states come from `classifyOpenCodeResultBody`, which encodes the
 * shapes the live server actually sends (see `adapt.ts` for the capture):
 *
 *   - `text`       paint it.
 *   - `empty`      the tool ran and produced nothing → "No output." is honest.
 *   - `unreadable` the tool produced something this card cannot decode. The
 *     old code collapsed that into `""` and printed "No output." — which is how
 *     a FAILED tool (the `{ error, type }` envelope, which carries no text
 *     field) came to read as a successful empty one. It now says so instead.
 */
function ResultBody({ result }: { result: unknown }) {
  const body = classifyOpenCodeResultBody(result);
  if (body.kind === "unreadable") {
    return (
      <span className="text-muted-foreground">{toolsConfig.copy.status.resultUnreadable}</span>
    );
  }
  if (body.kind === "empty") {
    return <span className="text-muted-foreground">{toolsConfig.copy.status.noOutput}</span>;
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground/90">
      {textPreview(body.text)}
    </pre>
  );
}

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
 * no renderer has to remember to ask for it. `BackendToolView` hands `summarize`
 * back the very `result` passed in here, and `normalizeOpenCodeResult` is
 * idempotent, so `summarize` receives it unchanged — normalizing again could
 * only re-wrap an already-normalized value.
 *
 * Every renderer this produces routes its approval state through
 * `BackendToolView` — the single dispatcher that reaches `ApprovalGate`, which
 * carries the stale-permission guard. Nothing here answers a gate itself, so
 * there is no second approval path to fall out of step.
 */
function openCodeView(spec: OpenCodeViewSpec): ToolCallMessagePartComponent {
  const View = (p: AnyProps) => {
    const args = normalizeOpenCodeArgs(spec.tool, p.args) ?? {};
    const result = normalizeOpenCodeResult(spec.tool, p.result);
    return (
      <BackendToolView
        title={spec.title(args)}
        args={args}
        {...(spec.argPreview ? { argPreview: spec.argPreview(args) } : {})}
        result={result}
        status={p.status}
        isError={p.isError}
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

const body = (result: unknown) => <ResultBody result={result} />;

/**
 * `read` — OpenCode args are `{ filePath, offset?, limit? }`; our rich UI's
 * `path` comes from the alias table. The result is the file text as a string.
 */
export const OpenCodeReadToolUI = openCodeView({
  tool: "read",
  title: (args) => toolsConfig.copy.toolTitle(toolsConfig.copy.tool.read, str(args.path)),
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
  title: (args) => toolsConfig.copy.toolTitle(toolsConfig.copy.tool.glob, str(args.query)),
  targetPath: (args) => str(args.path, "."),
  runningLabel: toolsConfig.copy.running.findingFiles,
  summarize: body,
});

/** `grep` — OpenCode args are `{ pattern, path?, include? }`. */
export const OpenCodeGrepToolUI = openCodeView({
  tool: "grep",
  title: (args) => toolsConfig.copy.toolTitle(toolsConfig.copy.tool.grep, str(args.query)),
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
      {typeof args.oldText === "string" ? textPreview(args.oldText, toolsConfig.limits.toolArgEditPreviewMaxChars) : ""}
    </pre>
    <div className="text-muted-foreground">Replace with:</div>
    <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
      {typeof args.newText === "string" ? textPreview(args.newText, toolsConfig.limits.toolArgEditPreviewMaxChars) : ""}
    </pre>
  </div>
);

/** The parsed files of a usable patch, rendered with the card's diff element. */
function PatchFiles({ files, fallbackName }: { files: readonly CodeDiffFile[]; fallbackName: string }) {
  if (files.length === 0) return null;
  return (
    <div data-slot="opencode-pending-diff" className="w-full space-y-2">
      {files.map((file) => {
        const name = patchFileName(file.filename, fallbackName);
        return (
          <CodeDiff
            key={name}
            filename={name}
            additions={file.additions}
            deletions={file.deletions}
            lines={file.lines}
            cycle={0}
          />
        );
      })}
    </div>
  );
}

/**
 * The files a patch actually shows as a change, or `[]` when it is not a diff.
 *
 * `patchToCodeDiffs` is lenient by design - it turns a line of prose into a
 * one-row "file" - which is right for the completed card, where the fallback is
 * to show the tool's own output. It is wrong for a decision: a diff header
 * reading `+0 -0` next to a sentence claims a change that does not exist, and
 * someone is being asked to allow it. So the gate checks for a real hunk header
 * first, and an unusable patch falls back to the find/replace pair rather than
 * rendering as a phantom edit.
 */
function usableDiffFiles(patch: string | null | undefined): readonly CodeDiffFile[] {
  if (typeof patch !== "string" || !isUnifiedDiff(patch)) return [];
  return patchToCodeDiffs(patch);
}

/**
 * `edit` — the completed body is a DIFF, not the result string.
 *
 * OpenCode's `edit` result is the literal string "Edit applied successfully.";
 * the actual patch lives in the part's `metadata` (see
 * `openCodePatchFromParts`). A diff is what a reader needs to review an edit, so
 * when the patch is reachable it replaces the string entirely.
 *
 * ## The approval gate shows the diff too
 *
 * Two patches reach this component and they are not interchangeable:
 *
 * - `pendingPatch` is what OpenCode computed BEFORE running the edit and sent
 *   with the permission request. It describes a change that has NOT happened -
 *   which is exactly what a reviewer is being asked to allow, so it is what the
 *   gate renders.
 * - `diffPatch` is what the server recorded once the edit ran. It can only ever
 *   describe the past, so it is what the completed card renders.
 *
 * The earlier version of this file deliberately kept the diff OUT of the gate and
 * showed the find/replace pair instead, on the reasoning that "the user would be
 * approving a change that has not happened yet". That reasoning had it backwards:
 * the change not having happened is the entire reason a gate exists. What the
 * reviewer needs before answering is the resulting change, not the model's
 * description of it - the find/replace pair omits the surrounding context, so it
 * cannot show whether the replacement lands where the author meant.
 *
 * The find/replace pair is kept, but only as the FALLBACK for when the server
 * sends no patch. Verified live: a gated `edit` arrives with
 * `metadata.files[0].patch` carrying a real `@@` hunk, so this is the rare path -
 * and a gate with no preview at all would be worse than one showing the pair.
 *
 * Pure on purpose: the patches arrive as PROPS so this stays renderable in a
 * unit test, where there is no `AuiProvider` — and `useAuiState` throws without
 * one ("requires an AuiProvider"), which would take the whole render down.
 * `OpenCodeEditToolUI` below is the thin, provider-aware wrapper.
 */
export const OpenCodeEditView = ({
  diffPatch,
  pendingPatch,
  ...p
}: AnyProps & { diffPatch?: string | null; pendingPatch?: string | null }) => {
  const args = normalizeOpenCodeArgs("edit", p.args) ?? {};
  const path = str(args.path);
  const pendingFiles = usableDiffFiles(pendingPatch);
  const recordedFiles = usableDiffFiles(diffPatch);
  return (
    <BackendToolView
      title={toolsConfig.copy.toolTitle(toolsConfig.copy.tool.edit, path)}
      args={args}
      argPreview={
        pendingFiles.length > 0 ? (
          <PatchFiles files={pendingFiles} fallbackName={path} />
        ) : (
          editPreview(args)
        )
      }
      result={normalizeOpenCodeResult("edit", p.result)}
      status={p.status}
      isError={p.isError}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.editing}
      summarize={() => {
        // Same shared conversion as the chat's ```diff fences, so an OpenCode
        // patch and a model-written patch render identically. This is the
        // RECORDED patch — the one the server kept once the edit ran. The
        // leniency question does not arise here: when there is nothing to show,
        // the fallback is OpenCode's own result text, not a decision.
        if (recordedFiles.length === 0) {
          // No reachable patch (a `write` part has none by data — see
          // `openCodePatchFromParts`), or nothing parseable: show what OpenCode
          // actually returned rather than an empty card.
          return <TextBody text={openCodeResultText(p.result) ?? ""} />;
        }
        return <PatchFiles files={recordedFiles} fallbackName={path} />;
      }}
      tool="edit"
      targetPath={str(args.path)}
    />
  );
};
OpenCodeEditView.displayName = "OpenCodeEditView";

/**
 * The raw official V2 tool parts of the message this part belongs to.
 *
 * `state.metadata` is dropped by the runtime projection, but the untouched parts
 * survive as message metadata (`metadata.custom.opencode.parts`) — the same
 * reach `ChatWindow` already uses for its provenance chips.
 *
 * ONE selector for the whole message, shared by every reader below: the `edit`
 * diff and the `websearch` provider both need this exact array, and two
 * `useAuiState` calls with the same selector would be two places to keep in
 * step with the projection's metadata key rather than one.
 */
function useOpenCodeRawParts(): unknown {
  return useAuiState(
    (s) =>
      (
        s.message.metadata?.custom as
          | { opencode?: { parts?: unknown } }
          | undefined
      )?.opencode?.parts,
  );
}

/**
 * Read the patch OpenCode recorded for this tool call.
 *
 * Returns null whenever the patch is absent, which includes every `write` part
 * (a whole-file write has nothing to diff against) and every not-yet-completed
 * part.
 */
function useOpenCodeEditPatch(callId: string | undefined): string | null {
  return openCodePatchFromParts(useOpenCodeRawParts(), callId);
}

/**
 * Read the patch a pending permission is asking to be allowed, out of the
 * message's own metadata.
 *
 * Pure, and a module-level export, for the same reason `openCodePatchFromParts`
 * is: the hook around it needs an `AuiProvider` and so cannot be rendered in a
 * unit test, but the part that can actually be wrong - the key path, the shape
 * check, the empty-string case, a call id that is not in the map - is all here.
 * Testing the reader is therefore testing the seam rather than a proxy for it.
 *
 * @param metadata - The message's `metadata.custom` value, or undefined.
 * @param callId - The tool call to look up; undefined yields null.
 * @returns The patch, or null when the call has no usable one.
 */
export function openCodePendingPatchFor(
  metadata: unknown,
  callId: string | undefined,
): string | null {
  if (metadata === null || typeof metadata !== "object" || callId === undefined) {
    return null;
  }
  const patches = (metadata as { opencode?: { pendingPatches?: unknown } }).opencode
    ?.pendingPatches;
  if (patches === null || typeof patches !== "object") return null;
  const patch = (patches as Record<string, unknown>)[callId];
  return typeof patch === "string" && patch.trim() !== "" ? patch : null;
}

/**
 * Read the patch the PENDING permission for this tool call is asking to be
 * allowed.
 *
 * Distinct from {@link useOpenCodeEditPatch}, and the distinction is the whole
 * point: that one reads the patch the server recorded on the tool part, which
 * only exists once the edit has run, so it can only ever describe a change that
 * has already happened. This one reads the patch OpenCode computed BEFORE
 * running the edit and sent with the question, so it is available while the
 * gate is still open - which is the only moment it is worth showing.
 */
function useOpenCodePendingPatch(callId: string | undefined): string | null {
  const custom = useAuiState((s) => s.message.metadata?.custom);
  return openCodePendingPatchFor(custom, callId);
}

/** `edit` — OpenCode args are `{ filePath, oldString, newString, replaceAll }`. */
export const OpenCodeEditToolUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => {
  const diffPatch = useOpenCodeEditPatch(p.toolCallId);
  const pendingPatch = useOpenCodePendingPatch(p.toolCallId);
  return <OpenCodeEditView {...p} diffPatch={diffPatch} pendingPatch={pendingPatch} />;
};
OpenCodeEditToolUI.displayName = "OpenCodeToolUI(edit)";

/**
 * `write` — OpenCode args are `{ content, filePath }`.
 *
 * The gate shows the change the write would make, from the same pre-computed
 * patch the `edit` gate uses. A whole-file write has no old text, so the raw
 * argument preview was a wall of the new file's contents: a reviewer scrolled a
 * file to answer "is this the change I want?", with no indication of which lines
 * are new because all of them are.
 *
 * The server answers this without any synthesis. Verified live: a pending
 * `write` arrives with `metadata.files[].patch` carrying a proper new-file
 * unified diff,
 *
 *     --- written.txt
 *     +++ written.txt
 *     @@ -0,0 +1,5 @@
 *     +# written by probe
 *     +
 *
 * so the existing `patchToCodeDiffs` + `CodeDiff` path renders it unchanged and
 * every line reads as an addition. No diff is generated in this app.
 *
 * Explicit rather than built on `openCodeView`, because the factory has no
 * access to the tool call id or the message metadata that carries the patch -
 * and a hook cannot be added to it conditionally, since ten other renderers use
 * it. This is the same pure-view-plus-wrapper split `edit` already uses.
 */
export const OpenCodeWriteView = ({
  pendingPatch,
  ...p
}: AnyProps & { pendingPatch?: string | null }) => {
  const args = normalizeOpenCodeArgs("write", p.args) ?? {};
  const path = str(args.path);
  const pendingFiles = usableDiffFiles(pendingPatch);
  return (
    <BackendToolView
      title={toolsConfig.copy.toolTitle(toolsConfig.copy.tool.write, path)}
      args={args}
      argPreview={
        pendingFiles.length > 0 ? (
          <PatchFiles files={pendingFiles} fallbackName={path} />
        ) : (
          contentPreview(args)
        )
      }
      result={normalizeOpenCodeResult("write", p.result)}
      status={p.status}
      isError={p.isError}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.writing}
      summarize={body}
      tool="write"
      targetPath={path}
    />
  );
};

export const OpenCodeWriteToolUI: ToolCallMessagePartComponent = (
  p: AnyProps,
) => <OpenCodeWriteView {...p} pendingPatch={useOpenCodePendingPatch(p.toolCallId)} />;
OpenCodeWriteToolUI.displayName = "OpenCodeToolUI(write)";

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
  const tool = p.toolName === "shell" ? "shell" : "bash";
  const args = normalizeOpenCodeArgs(tool, p.args) ?? {};
  const command = str(args.command);
  // `resultToLines` dereferences its argument, so an absent result (a part that
  // is still running, or one with no output at all) must be handled here.
  const shaped = normalizeOpenCodeResult(tool, p.result);
  const lines = shaped == null ? [] : resultToLines(shaped as { stdout?: unknown });

  // The gate owns the card in every state it renders, so the terminal may only
  // appear once the gate has nothing left to say. This mirrors the gate's own
  // condition verbatim — `ApprovalGate` branches on `approval.approved ===
  // undefined` (filesystem/ui.tsx:472) and covers both "awaiting an answer" and
  // "the request is gone" (`resolution` set → ClosedGateMessage). Narrowing this
  // to only the awaiting case would let a closed gate's message be replaced by
  // stale output.
  const gateOwnsCard = p.approval != null && p.approval.approved === undefined;
  // A FAILED call must not be able to reach the fast path either, for the same
  // reason: this branch never goes through `BackendToolView`, so it never sees
  // the failure row. Today the captured error envelope (`{ error, type }`, no
  // `content` — see `adapt.ts`) carries no `stdout`, so `lines` is empty and
  // the branch cannot fire; this states the rule rather than relying on that, and
  // matches the guard the Direct `RunCommandTerminalUI` already applies to its
  // own equivalent branch.
  const failed = p.isError === true || p.status?.type === "incomplete";

  if (!gateOwnsCard && !failed && p.status?.type !== "running" && lines.length > 0) {
    return (
      <div className="my-1 w-full">
        <TerminalBlock
          command={command}
          lines={lines}
          visibleCount={lines.length}
          done={true}
          variant="ink"
        />
      </div>
    );
  }

  return (
    <BackendToolView
      title={`${tool} · ${command}`}
      args={args}
      result={shaped}
      status={p.status}
      isError={p.isError}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.running}
      summarize={body}
      tool={tool}
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

/**
 * The delegated-agent call — handing work to a subagent such as `explore` or
 * `general`.
 *
 * ## The name was wrong, which is the whole bug
 *
 * Verified against the running server on 2026-09-30: a real turn that delegates
 * emits a tool part named **`subagent`**, with arguments
 * `{ agent, description, prompt }`. The registry carried this renderer under
 * **`task`**, reading `subagent_type` — a tool name and an argument the server
 * never sends.
 *
 * The consequence is exactly the reported symptom. A name-keyed registry that
 * lacks the name the server used means the renderer never fires, the part falls
 * through to `ToolFallback`, and the delegated call renders as a raw dump:
 * `Used tool: subagent {"agent":"general","description":"…","prompt":"…"}`. So "a
 * subagent call shows nothing of what it did" was not a display choice and not a
 * missing feature — it was an **unregistered tool**.
 *
 * ## What it can honestly show
 *
 * The prompt it was given, and the text the subagent returned. That is all the
 * data that reaches the app: the session stream carries no child parts for a
 * delegated call, no parented message link, and the OpenCode server answers 404
 * for every child-session route. The subagent's *internal* steps are not
 * available to any client, so this card does not pretend to list them. Showing
 * the delegated prompt and the returned answer is a real improvement over a JSON
 * dump; a fabricated step list would not be.
 *
 * ## Why `task` stays registered
 *
 * An OpenCode build that names the tool `task` would otherwise lose the card
 * entirely, and an inert registry entry costs nothing. It is **not** verified —
 * only `subagent` is. Both spellings of the agent argument are read, so the card
 * is right for either build rather than right for one and blank for the other.
 */
function subagentView(tool: "subagent" | "task") {
  return openCodeView({
    tool,
    title: (args) =>
      toolsConfig.copy.toolTitle(
        toolsConfig.copy.tool.subagent,
        str(args.agent ?? args.subagent_type, toolsConfig.copy.tool.subagent),
      ),
    argPreview: (args) => <TextBody text={str(args.prompt)} />,
    runningLabel: toolsConfig.copy.running.runningSubagent,
    summarize: body,
  });
}

/** The name the running server uses. Read the note above before renaming this. */
export const OpenCodeSubagentToolUI = subagentView("subagent");

/** The older spelling. Unverified; kept so such a build does not lose the card. */
export const OpenCodeTaskToolUI = subagentView("task");

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
      ? toolsConfig.copy.toolTitle(toolsConfig.copy.tool.todowrite, toolsConfig.copy.status.completedOf(completed, list.length))
      : toolsConfig.copy.toolTitle(toolsConfig.copy.tool.todowrite, toolsConfig.copy.tool.empty);
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
  title: (args) => toolsConfig.copy.toolTitle(toolsConfig.copy.tool.webfetch, str(args.url)),
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
 * and the element would never render at all. The conditions below mirror
 * `BackendToolView`'s own branches, so no state it handles is lost:
 *
 *   1. `gateUndecided`        — awaiting an answer, or the request is gone
 *   2. `awaitingContinuation` — approved, but execution rides the next message
 *   3. `failed`               — cancelled / incomplete
 *   4. `denied`               — a denial, via the shared `denialOf` rule
 *
 * The element additionally owns a settled call whose payload IS the verified
 * document, and a still-running one (for its shimmer). A settled call the
 * parser could NOT read stays with the shared shell: the element derives its
 * status line from `results.length`, so handing it nothing would print
 * "Read 0 sources" beside a result the model then answers from — the exact
 * symptom of the zero-results bug. The shared shell shows the same real payload
 * as its body, so nothing is invented and nothing is lost.
 *
 * The raw document stays visible beneath the element on purpose: the element
 * shows only `title` + `domain`, while the payload also carries every hit's full
 * `url`, its `Published:` date and the provider's snippet, and discarding those
 * to fit the element would lose real information.
 *
 * THE PROVIDER CAPTION. Which search engine answered is the one fact a reader
 * cannot get from the card otherwise, and it exists in exactly one place —
 * `state.metadata.provider` on the raw part (see
 * `openCodeWebSearchProviderFromParts`). The element is a frozen vendored file
 * with no prop, slot or footer for it, so the caption is a TBAi-owned line in
 * the block this renderer already owns, placed between the element and the raw
 * document: nearest the rows it qualifies, and above the document that is
 * reference material rather than the summary. It renders only when the payload
 * states a provider.
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
  const result = normalizeOpenCodeResult("websearch", p.result);
  const query = propStatus.query === "streaming" ? toolsConfig.copy.running.searching : str(args.query);
  const hits = parseOpenCodeWebSearchHits(result);
  const raw = openCodeResultText(result) ?? "";
  const running = p.status?.type === "running";
  // Which search provider answered. `null` when the payload does not say — the
  // element branch then simply has no caption rather than an empty label, so a
  // search whose provider is unknown reads as "not stated", never as "unknown".
  const provider = openCodeWebSearchProviderFromParts(
    useOpenCodeRawParts(),
    p.toolCallId,
  );

  const gateUndecided = p.approval != null && p.approval.approved === undefined;
  const awaitingContinuation =
    p.approval?.approved === true &&
    result === undefined &&
    p.status?.type !== "running";
  const failed = p.status?.type === "incomplete" || p.isError === true;
  const denied = denialOf(result, p.approval) != null;
  // `null` means "not the verified document" — see the header comment.
  const elementOwnsCard = hits !== null || running;

  if (!gateUndecided && !awaitingContinuation && !failed && !denied && elementOwnsCard) {
    return (
      <div className="my-1 w-full space-y-2">
        <WebSearch
          query={query}
          results={hits ?? []}
          visibleResults={toolsConfig.limits.webSearchMaxResults}
          searching={running}
          cycle={0}
        />
        {provider ? (
          <div className="text-muted-foreground text-xs">
            {toolsConfig.copy.webSearch.searchedVia(provider)}
          </div>
        ) : null}
        {raw ? <TextBody text={raw} /> : null}
      </div>
    );
  }

  return (
    <BackendToolView
      title={toolsConfig.copy.toolTitle(toolsConfig.copy.tool.websearch, str(args.query))}
      args={args}
      result={result}
      status={p.status}
      isError={p.isError}
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
  title: (args) => toolsConfig.copy.toolTitle(toolsConfig.copy.tool.skill, str(args.name)),
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
 * The asked questions, and the answer once there is one.
 *
 * ## Why the options are NOT listed while the question is open
 *
 * They used to be, as `· label` bullets. That is the defect this card had: it
 * printed three clickable-looking options on a surface with no controls on them,
 * then told the reader to answer somewhere else. The only place a question is
 * answered is the dock above the composer, so that is all this card says while
 * it is open. Printing the options here bought nothing and invited a click that
 * could never do anything.
 *
 * ## Why the pointer is suppressed once the question is settled
 *
 * `cancelled` is a FORM state, not a tool state — a tool part is only `pending`,
 * `running`, `completed` or `error`. So a question the reader dismissed and a
 * question that genuinely failed arrive here identically: `error`, with no
 * `answers`. The card must therefore not distinguish them, and must not send
 * either of them to the dock. Telling a settled question to "answer this in the
 * question box just above the text field" points at a box that is never coming
 * back — the same dead end the open-question pointer used to create, reached
 * by cancelling instead of by reading.
 *
 * So the pointer is printed for exactly one case: a question that is still
 * live, where a form genuinely exists and can genuinely be answered. Everything
 * else is described by what it is.
 *
 * ## What the settled card shows
 *
 * The answer, and the description of the option it came from — which is the
 * reason it was chosen, and the part a reader looking back wants. The
 * alternatives are not re-listed to highlight one of them; that turned a
 * receipt back into a menu.
 *
 * `answers` is the completed part's own `state.metadata.answers`
 * (`openCodeQuestionAnswersFromParts`) — `string[][]`, outer array indexed by
 * question.
 */
function questionBody(
  args: AnyArgs,
  answers: readonly (readonly string[])[] | null,
  state: QuestionCardState,
): ReactNode {
  const questions = questionList(args);
  if (questions.length === 0) {
    return <span className="text-muted-foreground">{toolsConfig.copy.status.noQuestionText}</span>;
  }
  return (
    <div className="space-y-3">
      {questions.map((q, i) => {
        const key = questionItemKey(str(q.header), str(q.question));
        const answer = answers?.[i] ?? null;
        const settled = state === "answered" && answer !== null && answer.length > 0;
        // The option the answer names, so its description can follow it. The
        // answer holds the option's LABEL, not its value, on a `question` call.
        const chosen = settled
          ? (Array.isArray(q.options) ? q.options : [])
            .map(asQuestion)
            .find((option) => option !== undefined && answer.includes(str(option.label)))
          : undefined;
        return (
          <div key={key}>
            {typeof q.header === "string" && q.header ? (
              <p className="text-xs font-medium text-muted-foreground">{q.header}</p>
            ) : null}
            <p className="text-foreground">{str(q.question)}</p>
            {settled ? (
              <div className="mt-1 text-xs">
                <p>
                  <span className="text-muted-foreground">{toolsConfig.copy.status.yourAnswer}: </span>
                  <span className="font-medium text-foreground">{answer.join(", ")}</span>
                </p>
                {chosen?.description ? (
                  <p className="mt-0.5 text-muted-foreground">{str(chosen.description)}</p>
                ) : null}
              </div>
            ) : null}
            {state === "closed" ? (
              <p className="mt-1 text-xs text-muted-foreground">{toolsConfig.copy.status.questionClosedNoAnswer}</p>
            ) : null}
          </div>
        );
      })}
      {state === "open" ? (
        <p className="text-xs text-muted-foreground">
          {toolsConfig.copy.status.answerInQuestionDock}
        </p>
      ) : null}
    </div>
  );
}

/** The `question` card title: the first question's header, else its text. */
function questionTitle(args: AnyArgs): string {
  const first = questionList(args)[0];
  return toolsConfig.copy.toolTitle(
      toolsConfig.copy.tool.question,
      str(first?.header) || str(first?.question) || toolsConfig.copy.tool.asked,
    );
}

/**
 * `question` — required `{ questions }`.
 *
 * A `question` tool call is rendered as a read-only historical tool result.
 * Interactive native V2 forms use the separate `session.form` lifecycle and
 * are owned by `OpenCodeQuestions`/`V2FormCard`. The tool renderer never
 * answers forms or writes a synthetic tool result — it only shows what the
 * reader already answered, from the completed part's own metadata.
 *
 * Hand-written rather than built by `openCodeView` for the same reason `edit`
 * is: the answer lives in `state.metadata`, which the runtime projection drops,
 * so the card needs `useOpenCodeRawParts()` and therefore a provider. The
 * answer arrives as a PROP instead, which keeps this half static-renderable in
 * a unit test with no `AuiProvider`.
 */
export const QuestionReadonlyView = (
  p: AnyProps & { readonly answers?: readonly (readonly string[])[] | null },
) => {
  const args = normalizeOpenCodeArgs("question", p.args) ?? {};
  const answers = p.answers ?? null;
  const state = questionCardState(p, answers);
  return (
    <BackendToolView
      title={questionTitle(args)}
      args={args}
      argPreview={questionBody(args, answers, state)}
      result={normalizeOpenCodeResult("question", p.result)}
      status={p.status}
      isError={p.isError}
      approval={p.approval}
      respondToApproval={p.respondToApproval}
      runningLabel={toolsConfig.copy.running.waitingForAnswer}
      summarize={(result) => (
        <div className="space-y-2">
          {questionBody(args, answers, state)}
          {body(result)}
        </div>
      )}
      tool="question"
    />
  );
};

/** What a question card can honestly say about itself. */
type QuestionCardState = "open" | "answered" | "closed";

/**
 * Whether the question is still answerable, already answered, or closed.
 *
 * ## Why "closed" covers both a dismissal and a failure
 *
 * The server's only tool statuses are `pending | running | complete | error`, and
 * `cancelled` exists only on the FORM, not on the tool call. A question the
 * reader dismissed therefore arrives exactly like one that genuinely failed:
 * `error`, with no `answers` in its metadata. Nothing in the payload separates
 * them, so the card does not claim to separate them — it says the question is
 * closed, which is true either way, and leaves the reason to the failure chip
 * that `BackendToolView` already renders from the real error.
 *
 * Inventing a distinction here would mean matching on the server's error prose,
 * which is precisely the fragility that makes OpenChamber's answer receipt
 * fragile. Refusing to guess is the correct behaviour, not a missing feature.
 *
 * ## Why "open" is the only state that points at the dock
 *
 * The dock exists only while a form is pending. Pointing a settled question at
 * it is the dead end this card used to have, and cancelling used to walk
 * straight back into it.
 */
function questionCardState(
  p: AnyProps,
  answers: readonly (readonly string[])[] | null,
): QuestionCardState {
  if (answers !== null && answers.length > 0) return "answered";
  const type = p.status?.type;
  if (type === "running" || type === "requires-action") return "open";
  // A settled part: `complete`, `incomplete` (any reason), or an explicit error.
  // An absent status is treated as settled rather than open, because the safe
  // mistake is silence — never sending a reader to a dock that cannot be there.
  return "closed";
}
QuestionReadonlyView.displayName = "OpenCodeToolUI(question)";

/** Reads the answers off the raw parts and hands them to `QuestionReadonlyView`. */
export const OpenCodeQuestionToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <QuestionReadonlyView
    {...p}
    answers={openCodeQuestionAnswersFromParts(useOpenCodeRawParts(), p.toolCallId)}
  />
);
