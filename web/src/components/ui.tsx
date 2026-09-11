import { Button as CanonicalButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export { cn } from "@/lib/utils";
export { Input, Textarea };

// Legacy compatibility surface: re-exports the canonical primitives so every
// call site shares one implementation. New code must import from
// "@/components/ui/*" directly — do not extend this file.
export interface LegacyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
}

export function Button({ variant = "default", size = "md", ...props }: LegacyButtonProps) {
  return (
    <CanonicalButton variant={variant} size={size === "md" ? "default" : size} {...props} />
  );
}
