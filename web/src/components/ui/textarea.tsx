import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      // Spell check is OFF by default here. This primitive backs fields that are
      // mostly not prose — JSON arguments, env var blocks, cron expressions,
      // file paths, tool payloads — where browser underlines are noise, and an
      // API key or a token must never be underlined. Placed BEFORE {...props}
      // so a caller that genuinely wants prose checking can opt in with
      // `spellCheck`. The one field that is a real message box (the composer)
      // does not use this primitive; it is user-controlled in Settings.
      spellCheck={false}
      className={cn(
        "border-input bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 resize-none rounded-xl border px-3 py-3 text-base transition-colors focus-visible:ring-[3px] aria-invalid:ring-[3px] md:text-sm placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
