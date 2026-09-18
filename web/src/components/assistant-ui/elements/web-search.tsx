"use client";

/**
 * Official assistant-ui "Web search" element, vendored from the registry:
 *
 *   https://r.assistant-ui.com/elements-web-search.json
 *   path: components/assistant-ui/elements/web-search.tsx
 *
 * Copied by hand rather than via `shadcn add` because this repo has no
 * `components.json`, and initializing one for a single element would add
 * tooling the project does not otherwise use. It brings no npm dependency —
 * `lucide-react` is already installed, and its one registry dependency
 * (`../utils/range`, providing `take`) is already vendored alongside it.
 *
 * ONE deliberate deviation from upstream, and nothing else: the status line
 * upstream reads the literal text `Read 3 sources`. Upstream's own docs call
 * that out ("literal text in the source, not derived from `results.length`;
 * edit it directly if the count should track what you pass in"), and a fixed
 * "3" beside a real result list states a false number. It now derives from
 * `results.length`. No field, prop or style was added.
 */

import type { ComponentProps } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { field, mono, ShimmerLabel } from "./surfaces";
import { take } from "../utils/range";

export interface WebSearchResult {
  title: string;
  domain: string;
}

export function WebSearch({
  query,
  results,
  visibleResults,
  searching,
  cycle,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "query" | "results" | "visibleResults" | "searching" | "cycle"
> & {
  query: string;
  results: readonly WebSearchResult[];
  visibleResults: number;
  searching: boolean;
  cycle: number;
}) {
  return (
    <div
      data-slot="web-search"
      className={cn("flex w-full max-w-sm flex-col gap-2.5", className)}
      {...props}
    >
      <span
        className={cn(
          field,
          "text-foreground/70 inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-2 text-xs",
        )}
      >
        <SearchIcon className="text-foreground/40 size-3" />
        {query}
      </span>
      <div className="text-foreground/45 text-xs">
        {searching ? (
          <ShimmerLabel className="relative inline-block leading-none">
            Searching
          </ShimmerLabel>
        ) : (
          <span className="fade-in animate-in duration-300">
            Read {results.length} source{results.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="flex min-h-[5.75rem] flex-col">
        {take(results, visibleResults).map((result) => (
          <div
            key={`${cycle}-${result.domain}`}
            className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both hover:bg-foreground/[0.03] -mx-2.5 flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 transition-colors duration-300"
          >
            <span className="bg-foreground/[0.06] text-foreground/45 flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-medium">
              {result.domain.charAt(0).toUpperCase()}
            </span>
            <span className="text-foreground/90 min-w-0 flex-1 truncate text-[13.5px]">
              {result.title}
            </span>
            <span className={cn(mono, "text-foreground/35 shrink-0")}>
              {result.domain}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
