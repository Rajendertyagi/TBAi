import type { ReactNode } from "react";
import { toolsConfig } from "@/config/tools";
import { BoundedBody } from "./body-budget";

/**
 * A tool result that is a flat list of named fields, rendered as rows.
 *
 * ## Why this exists
 *
 * Six tools returned a raw `Json` envelope: `file_info`, `system_info`,
 * `scheduler`, `delete_file`, `process_kill` and `write_file`. Every one of them
 * returns the *same kind of thing* — a small, flat object of named primitives:
 *
 *     { path, deleted, wasDir }
 *     { platform, arch, release, hostname, cpuCount, cpuModel, ... }
 *     { pid, killed }
 *     { path, bytes, created }
 *
 * which is key/value data, not a machine payload. Rendering it as
 * `JSON.stringify(…, null, 2)` spent a card's whole width on braces, quotes and
 * indentation so the reader could find one fact on it.
 *
 * ## Minimum custom code, and why it is not a library element
 *
 * There is no vendored assistant-ui element for structured tool output, so
 * something had to be written. What is here is deliberately the smallest thing
 * that does the job:
 *
 * - It handles **only** the flat case. Anything nested falls back to the
 *   existing bounded `Json` body, because a key/value list of objects renders
 *   `[object Object]` and is worse than the JSON it replaced.
 * - It does not format, translate or pretty-print a single value. The values are
 *   shown as they are, so this component cannot disagree with the tool about
 *   what it returned.
 * - It has no notion of a schema, an ordering, or a label for a field. The
 *   object's own key order is the order, which is the order the tool chose.
 *
 * The alternative — a table of typed columns with units and a summary line — is
 * the thing OpenChamber reaches for with a `JsonSummaryView` plus a
 * `JsonTreeViewer`, and it costs a tree walker, three render modes and a node
 * budget that does not exist. None of that is warranted for `{ pid, killed }`.
 *
 * ## The relationship to the existing summaries
 *
 * `dirSummary` and `processSummary` are the same idea with a custom layout — a
 * name column and a size column, and a name plus a memory figure. They were left
 * alone while this component was additive. They are now unified onto
 * {@link ResultList} and {@link ResultRow}: the row layout, the truncation and
 * the omission note were written three times over, and two of the three emitted
 * `<dt>`/`<dd>` with no `<dl>` parent, which is not valid HTML.
 *
 * ## Why this is not OpenChamber's `JsonSummaryView`
 *
 * That renderer was read before deciding
 * (`packages/ui/src/components/chat/message/parts/JsonSummaryView.tsx`). It is a
 * recursive tree walker, and it makes four guesses about data whose shape this
 * app already knows: it rewrites keys (`wasDir` → `"Was Dir"`), links any
 * `http(s)` string into an anchor, promotes `id`/`name`/`title` into a synthetic
 * identity line, and wraps nested values in `<details>`. It also carries a 512 KB
 * output cap and an OOM guard. None of that is warranted for `{ pid, killed }`,
 * and two of the four guesses would show a reader something the tool never said.
 * So the shared row stays flat and literal: keys are painted as the tool spelled
 * them, and no value is reformatted.
 *
 * ## Not a shadcn `Table`
 *
 * shadcn's `Table` is vendored-elsewhere and correct for page-level data. Its
 * rows carry `border-b` and `hover:bg-muted/50` and its heads are `h-10` — page
 * chrome that would fight the tool-card surface these rows live in, and would
 * have to be overridden back out again. That is the custom code this file exists
 * to avoid, in a library's costume.
 */

/** Row cap, so a pathological flat object cannot become a very long card. */
const MAX_FIELDS = toolsConfig.limits.resultFieldMaxRows;

/** A value this renders inline, as text. Everything else disqualifies the object. */
function isPrimitiveField(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** The field pairs of a flat object, or `null` when it is not flat. */
function flatFields(
  value: unknown,
): { key: string; value: unknown }[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, field]) => ({ key, value: field }),
  );
  if (entries.length === 0) return null;
  if (!entries.every((entry) => isPrimitiveField(entry.value))) return null;
  return entries;
}

/** How a primitive is written. Numbers keep their own form; nothing is coerced. */
function renderValue(value: unknown): ReactNode {
  if (value === null) {
    return <span className="text-muted-foreground">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-muted-foreground">{value ? "yes" : "no"}</span>;
  }
  if (typeof value === "string" && value === "") {
    return <span className="text-muted-foreground">empty</span>;
  }
  return String(value);
}

/**
 * Renders a flat tool result as labelled rows, or nothing.
 *
 * Returning `null` is the normal outcome for most values, and callers are
 * expected to pair it with a fallback rather than treat it as an error:
 *
 * ```tsx
 * const fields = flatResultFields(result);
 * return fields === null ? <Json value={result} /> : <FieldList {...fields} />;
 * ```
 *
 * @param value - The tool result, unwrapped from any content envelope.
 * @returns Field rows, or null when the value is not a flat list of primitives.
 */
export function flatResultFields(
  value: unknown,
): { fields: { key: string; value: unknown }[]; hidden: number } | null {
  const entries = flatFields(value);
  if (entries === null) return null;
  return { fields: entries.slice(0, MAX_FIELDS), hidden: entries.length - MAX_FIELDS };
}

/** The rows themselves. Use {@link flatResultFields} to decide whether to. */
export function FieldList({
  fields,
  hidden,
}: {
  fields: { key: string; value: unknown }[];
  hidden: number;
}) {
  return (
    <ResultList
      slot="tool-result-fields"
      omitted={hidden}
      omittedLabel={toolsConfig.copy.status.resultFieldsOmitted}
    >
      {fields.map((field) => (
        <ResultRow
          key={field.key}
          label={field.key}
          value={renderValue(field.value)}
          valueTitle={String(field.value)}
        />
      ))}
    </ResultList>
  );
}

/**
 * A list of tool-result rows, plus an honest note when rows were withheld.
 *
 * Owns the `<dl>` that makes the rows a description list, the shared spacing,
 * and the omission note. It does NOT apply the cap: every caller caps with its
 * own limit, because a directory listing, a process listing and a flat result
 * are bounded for different reasons and the reasons are recorded per limit in
 * `toolsConfig.limits`.
 *
 * @param slot - `data-slot` value. Distinct per surface so a test can target one.
 * @param omitted - How many rows were withheld. Zero or less renders no note.
 * @param omittedLabel - Builds the note from the withheld count.
 */
export function ResultList({
  slot,
  omitted = 0,
  omittedLabel,
  children,
}: {
  slot: string;
  omitted?: number;
  omittedLabel: (count: number) => string;
  children: ReactNode;
}) {
  return (
    <dl data-slot={slot} className="space-y-0.5 text-xs">
      {children}
      {omitted > 0 && <div className="text-muted-foreground">{omittedLabel(omitted)}</div>}
    </dl>
  );
}

/**
 * One tool-result row: a label on the left, an optional value on the right.
 *
 * The label truncates and the value does not, so a long path can never push a
 * size or a pid off the card. `icon` sits outside the truncating span so a
 * glyph is never the thing that gets clipped.
 */
export function ResultRow({
  icon,
  label,
  value,
  valueTitle,
}: {
  icon?: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  valueTitle?: string;
}) {
  return (
    // A `div` grouping one `dt`/`dd` pair is valid inside a `dl`; `dt` and `dd`
    // are not valid as children of a bare `div`, which is what this used to be.
    <div className="flex justify-between gap-4">
      <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </dt>
      {value === undefined ? null : (
        <dd className="shrink-0 text-right font-mono" title={valueTitle}>
          {value}
        </dd>
      )}
    </div>
  );
}

/**
 * A tool result, as labelled rows when it is a flat object and as a bounded JSON
 * body when it is not.
 *
 * The single seam every native renderer should use in place of a bare
 * `<Json value={r} />`, so the readable case is the default and the fallback is
 * automatic rather than something each call site has to remember.
 *
 * The fallback is built on `BoundedBody` rather than on the `Json` component
 * from `filesystem/ui`, because `filesystem/ui` imports this module for its own
 * call sites. Importing the other way would close a cycle between two modules
 * that both render tool bodies. `BoundedBody` is the primitive underneath `Json`
 * anyway, and repeating the two-line serialisation here is cheaper than a cycle.
 */
export function FieldsOrJson({ value }: { value: unknown }) {
  const flat = flatResultFields(value);
  if (flat !== null) return <FieldList {...flat} />;
  return (
    <BoundedBody
      text={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    />
  );
}
