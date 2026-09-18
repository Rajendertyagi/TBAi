"use client";

/**
 * Official assistant-ui "Code diff" element, vendored from the registry:
 *
 *   https://r.assistant-ui.com/elements-code-diff.json
 *   path: components/assistant-ui/elements/code-diff.tsx
 *
 * Copied by hand rather than via `shadcn add` because this repo has no
 * `components.json`, and initializing one for a single element would add
 * tooling the project does not otherwise use. It brings **no** npm dependency;
 * its only registry dependency (`./surfaces`) is already vendored.
 *
 * TWO deliberate deviations from upstream, and nothing else:
 *
 * 1. **Theming.** Upstream tints added/removed rows with hardcoded Tailwind
 *    palette colours (`bg-emerald-500/10`, `text-emerald-700`, `text-red-600`,
 *    …). This repo themes diffs through its own semantic tokens, so those
 *    classes are replaced by the same `var(--diff-*, <default>)` pattern the
 *    legacy `DiffViewer` used — identical defaults, so the out-of-the-box look
 *    is unchanged, but a theme can now override `--diff-add-bg` /
 *    `--diff-add-rule` / `--diff-add-text` and the `--diff-del-*` trio exactly
 *    as before. The `--diff-*-rule` tokens are honoured as the inset rule bar,
 *    which upstream's element had no equivalent for.
 * 2. **A hyphen, not U+2212, in the counts and the gutter** — `-1`, not `−1`.
 *    This is what the legacy `DiffViewer` rendered, so the migration does not
 *    change a single visible character, and it keeps the existing
 *    `rendering.test.tsx` assertions true as written.
 *
 * No prop, field or behaviour was added or removed.
 */

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { codeScroll, codeSurface, mono, paper } from "./surfaces";

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const GUTTER: Record<DiffKind, string> = {
  context: "",
  added: "+",
  // Hyphen, not U+2212 — matches the legacy viewer's output (deviation 2).
  removed: "-",
};

/** Row tint + inset rule, driven by the semantic `--diff-*` tokens. */
const ROW: Record<DiffKind, string> = {
  context: "",
  added:
    "bg-[var(--diff-add-bg,var(--_diff-add-bg))] shadow-[inset_2px_0_0_var(--diff-add-rule,var(--color-green-500))] [--_diff-add-bg:color-mix(in_oklab,var(--color-green-500)_8%,transparent)] dark:[--_diff-add-bg:color-mix(in_oklab,var(--color-green-500)_15%,transparent)]",
  removed:
    "bg-[var(--diff-del-bg,var(--_diff-del-bg))] shadow-[inset_2px_0_0_var(--diff-del-rule,var(--color-red-500))] [--_diff-del-bg:color-mix(in_oklab,var(--color-red-500)_8%,transparent)] dark:[--_diff-del-bg:color-mix(in_oklab,var(--color-red-500)_15%,transparent)]",
};

/** Gutter-character tint, driven by the semantic `--diff-*` tokens. */
const GUTTER_TEXT: Record<DiffKind, string> = {
  context: "text-foreground/45",
  added:
    "text-[var(--diff-add-text,var(--color-green-600))] dark:text-[var(--diff-add-text-dark,var(--color-green-400))]",
  removed:
    "text-[var(--diff-del-text,var(--color-red-600))] dark:text-[var(--diff-del-text-dark,var(--color-red-400))]",
};

const COUNT_ADDED =
  "text-[var(--diff-add-text,var(--color-green-600))] dark:text-[var(--diff-add-text-dark,var(--color-green-400))]";
const COUNT_REMOVED =
  "text-[var(--diff-del-text,var(--color-red-600))] dark:text-[var(--diff-del-text-dark,var(--color-red-400))]";

export function CodeDiff({
  filename,
  additions,
  deletions,
  lines,
  cycle,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "filename" | "additions" | "deletions" | "lines" | "cycle"
> & {
  filename: string;
  additions: number;
  deletions: number;
  lines: readonly DiffLine[];
  cycle: number;
}) {
  return (
    <div
      data-slot="code-diff"
      className={cn(
        paper,
        "w-full max-w-md overflow-hidden rounded-2xl font-mono text-xs",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-foreground/90">{filename}</span>
        <span className={cn(mono, "tabular-nums")}>
          <span className={COUNT_ADDED}>+{additions}</span>{" "}
          <span className={COUNT_REMOVED}>-{deletions}</span>
        </span>
      </div>
      <div className={codeScroll}>
        <div className={codeSurface}>
          {lines.map((line, i) => (
            <div
              key={`${cycle}-${i}-${line.text}`}
              className={cn(
                "fade-in animate-in fill-mode-both flex px-4 py-0.5 leading-relaxed whitespace-pre duration-300",
                line.kind === "context" && "text-foreground/45",
                ROW[line.kind],
              )}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <span
                className={cn("w-4 shrink-0 select-none", GUTTER_TEXT[line.kind])}
              >
                {GUTTER[line.kind]}
              </span>
              <span className={cn(line.kind !== "context" && GUTTER_TEXT[line.kind])}>
                {line.text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
