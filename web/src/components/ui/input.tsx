import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      // Spell check is OFF by default here: this primitive backs API keys, model
      // names, folder names, ports and other identifiers, where underlines are
      // noise and a secret must never be marked as misspelled. Placed BEFORE
      // {...props} so a caller can opt in with `spellCheck`.
      spellCheck={false}
      className={cn(
        "bg-input/30 border-edge-default hover:border-edge-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 min-h-[2.25rem] h-auto rounded-md border px-3 py-1.5 text-base transition-colors file:h-7 file:text-sm file:font-medium aria-invalid:ring-2 md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-muted/40 read-only:text-muted-foreground read-only:cursor-default",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
