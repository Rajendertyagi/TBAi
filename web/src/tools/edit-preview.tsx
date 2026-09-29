import { useEffect, useState, type ReactNode } from "react";
import { toolsConfig } from "@/config/tools";
import { patchToCodeDiffs, type CodeDiffFile } from "@/lib/patch-to-diffs";
import { textPreview } from "@/tools/text-preview";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";

/**
 * The change a Direct-chat `edit_file` call would make, rendered as a diff.
 *
 * ## Why this fetches at all
 *
 * The Code surface gets this for free: OpenCode computes the patch before
 * running the tool and ships it on the permission request. Direct chat has no
 * such channel — AI SDK v7's `ToolApprovalRequestOutput` carries only the tool
 * call, a reason, and an HMAC signature binding them, with no slot for
 * server-supplied data and no way to extend the signed payload. So the gate
 * asks the server directly, through a route that is `runEdit` minus the write.
 *
 * The alternative was leaving the gate showing the model's Find/Replace pair,
 * which is what this replaces. That pair cannot show whether the replacement
 * lands where the author meant, because it omits the surrounding context
 * entirely — which is the thing a reviewer is actually judging.
 *
 * ## Why there is no diff library, here or on the server
 *
 * `edit_file` is a contiguous string replacement, so the change is already
 * known: which lines the match occupies and which lines replace them. The server
 * emits a standard unified patch; this parses it with the app's existing
 * `patchToDiffs`, exactly as every other diff in the app is rendered. There is
 * no diff-generation code in the browser and no diff dependency in the tree.
 *
 * ## Every failure lands on the old behaviour
 *
 * The endpoint is refused, the file moved, `oldText` no longer matches, the
 * network is down, or the patch does not parse — in all of those the gate shows
 * the Find/Replace pair. A gate must always show *something* the reader can
 * judge, and the pair is worse than a diff but far better than a blank card.
 *
 * ## The decision is a pure function, on purpose
 *
 * `previewFiles` is the whole contract — "is this a usable diff, or must we fall
 * back" — and it is pure so it can be tested without a DOM. This repo has no DOM
 * under `bun test` and every component test renders through
 * `renderToStaticMarkup`, which captures only the first paint; a transition
 * cannot be asserted that way. Rather than add a DOM dependency to test a
 * three-line decision, the decision is a function.
 *
 * ## No assistant-ui state is read here, on purpose
 *
 * This uses only `useState` and `useEffect`, never `useAuiState`. `useAuiState`
 * throws outside an `AuiProvider`, and the tool renderers here are rendered bare
 * by `renderToStaticMarkup` in several tests; and a component reading the
 * runtime would need thread context for no reason, since the request is a plain
 * POST of three arguments.
 */

type AnyArgs = Record<string, unknown>;

/** The server's answer to the preview request. */
export interface EditPreview {
  readonly patch: string;
  readonly occurrences: number;
}

/**
 * The files a preview answer is worth rendering, or `null` to fall back.
 *
 * `null` is the normal outcome for a failed or absent preview, and callers pair
 * it with the pair rather than treating it as an error. A patch that parses to
 * nothing is treated exactly like a missing one: rendering it would put a
 * `+0 -0` header next to prose and claim a change that does not exist.
 */
export function previewFiles(preview: EditPreview | null): readonly CodeDiffFile[] | null {
  if (preview === null || typeof preview.patch !== "string") return null;
  if (preview.patch.trim() === "") return null;
  const files = patchToCodeDiffs(preview.patch);
  return files.length === 0 ? null : files;
}

/**
 * The Find/Replace pair. Kept as the fallback, and exported so the fallback is
 * testable on its own rather than only as the absence of a diff.
 */
export function EditFindReplaceBody({
  oldText,
  newText,
}: {
  oldText: unknown;
  newText: unknown;
}) {
  const cap = toolsConfig.limits.toolArgEditPreviewMaxChars;
  return (
    <div className="space-y-1 text-xs">
      <div className="text-muted-foreground">Find:</div>
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
        {typeof oldText === "string" ? textPreview(oldText, cap) : ""}
      </pre>
      <div className="text-muted-foreground">Replace with:</div>
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
        {typeof newText === "string" ? textPreview(newText, cap) : ""}
      </pre>
    </div>
  );
}

/** The diff for a preview, or the pair when the preview is not usable. */
function renderPreview(
  preview: EditPreview | null,
  args: AnyArgs,
  fallbackName: string,
): ReactNode {
  const files = previewFiles(preview);
  if (files === null || preview === null) {
    return <EditFindReplaceBody oldText={args.oldText} newText={args.newText} />;
  }
  return (
    <div className="w-full space-y-2">
      {files.map((file) => {
        // The patch names its own file; fall back to the tool's `path` argument.
        // Never invented, and never empty: a diff with no filename is a diff the
        // reader cannot place.
        const label = file.filename === "" ? fallbackName : file.filename;
        return (
          <CodeDiff
            key={label}
            filename={label}
            additions={file.additions}
            deletions={file.deletions}
            lines={file.lines}
            cycle={0}
          />
        );
      })}
      {preview.occurrences > 1 && (
        // The preview shows the FIRST match exactly. Later matches sit at line
        // numbers shifted by the edits before them, so showing them would mean
        // printing locations that are only right after the earlier ones are
        // applied. Saying how many there are is the honest, useful part.
        <p className="text-muted-foreground text-[11px]">
          {toolsConfig.copy.status.editPreviewMoreOccurrences(preview.occurrences)}
        </p>
      )}
    </div>
  );
}

/**
 * The gate body for `edit_file`.
 *
 * Renders the pair on first paint and replaces it with the diff when the answer
 * arrives, so the card is never empty while the request is in flight. The swap is
 * a replacement rather than an addition, so the card does not grow twice.
 */
export function EditPreviewBody({
  args,
  fallbackName,
}: {
  args: AnyArgs;
  fallbackName: string;
}) {
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const path = typeof args.path === "string" ? args.path : "";
  const oldText = typeof args.oldText === "string" ? args.oldText : "";
  const newText = typeof args.newText === "string" ? args.newText : "";

  useEffect(() => {
    // Incomplete arguments cannot produce a patch, and asking anyway would send
    // a request the server is bound to reject.
    if (path === "" || oldText === "") return;
    const controller = new AbortController();
    void fetch("/api/tools/edit-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, oldText, newText }),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? (res.json() as Promise<EditPreview>) : null))
      .then((data) => {
        if (data !== null && typeof data.patch === "string" && data.patch.trim() !== "") {
          setPreview({
            patch: data.patch,
            occurrences: typeof data.occurrences === "number" ? data.occurrences : 1,
          });
        }
      })
      .catch(() => {
        // A refused request is the expected shape of "no preview available",
        // not an error to surface. The pair is already on screen.
      });
    return () => controller.abort();
  }, [path, oldText, newText]);

  return renderPreview(preview, args, fallbackName);
}
