"use client";

/**
 * Mermaid source normalisation, applied in THIS app's wiring rather than in the
 * vendored element.
 *
 * The vendored element renders through beautiful-mermaid, which accepts a subset
 * of mermaid and validates the diagram header strictly: it must be `graph <dir>`
 * or `flowchart <dir>` and nothing else. Probed against the installed package:
 *
 *   graph TD            -> renders
 *   graph TD;           -> Invalid mermaid header
 *   graph TD ;          -> Invalid mermaid header
 *   flowchart TD        -> renders
 *   flowchart TD;       -> Invalid mermaid header
 *   graph TD\n  A-->B;  -> renders   (semicolons in the BODY are fine)
 *   sequenceDiagram;    -> renders   (only graph/flowchart are strict)
 *
 * Models very often emit the semicolon form, so without this the user sees the
 * fallback panel for a diagram that is perfectly valid mermaid.
 *
 * This lives here, and not in mermaid-diagram.tsx, on purpose: editing the
 * vendored file would fork it from upstream and make every future update a
 * merge. Wrapping the element keeps the upstream source byte-identical to the
 * registry while still handling the common case.
 *
 * Deliberately NOT normalised, because the renderer genuinely does not support
 * it and pretending otherwise would hide a real limitation: a diagram whose body
 * shares the header line (`graph TD A-->B`) is rejected whether or not it has
 * semicolons. The header must be alone on its line.
 */
import type { FC } from "react";
import {
  MermaidDiagram as MermaidDiagramBase,
  type MermaidDiagramProps,
} from "./mermaid-diagram.aui";

/**
 * A `graph`/`flowchart` header that is alone on its line, optionally
 * terminated by a semicolon. Anchored so body lines and other diagram types are
 * never touched.
 */
const HEADER_WITH_OPTIONAL_SEMICOLON =
  /^(\s*(?:graph|flowchart)\s+[A-Za-z]+\s*);\s*$/;

/**
 * Drop a stray semicolon from a `graph`/`flowchart` header line.
 *
 * Returns the input unchanged when it is already valid, when the header belongs
 * to another diagram type, or when the body shares the header line - the
 * renderer rejects that form for reasons this cannot fix.
 */
export function normaliseMermaidSource(code: string): string {
  if (!code.includes(";")) return code;

  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const match = HEADER_WITH_OPTIONAL_SEMICOLON.exec(line);
    if (match) {
      lines[i] = match[1].replace(/\s+$/, "");
      return lines.join("\n");
    }
    // First meaningful line is not a strict header: nothing further to do.
    return code;
  }
  return code;
}

/**
 * The `componentsByLanguage.mermaid.SyntaxHighlighter` this app registers.
 *
 * Same contract as the vendored element - it is a drop-in for that slot - with
 * the source normalised on the way through.
 */
export const MermaidSyntaxHighlighter: FC<MermaidDiagramProps> = (props) => {
  const { code, ...rest } = props;
  return <MermaidDiagramBase {...rest} code={normaliseMermaidSource(code)} />;
};
