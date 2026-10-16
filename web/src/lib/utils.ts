import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names for one element, letting later Tailwind utilities win.
 *
 * `clsx` composes the inputs (arrays, objects, conditionals); `tailwind-merge`
 * then drops earlier utilities that a later one overrides. That resolution
 * happens WITHIN a single `cn(...)` call — `cn("p-2", isActive && "p-4")`
 * yields `p-4`, not both.
 *
 * It does not merge across elements. Two components that each carry their own
 * `p-2` are unaffected by this helper; only classes passed together to the same
 * call are reconciled.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
