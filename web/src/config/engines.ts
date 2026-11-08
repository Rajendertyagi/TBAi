import type { ComponentType } from "react";
import { MessageSquare, Terminal } from "lucide-react";

export type EngineId = "direct" | "opencode";

export interface EngineVisual {
  id: EngineId;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  color: string;
  foreground: string;
  badgeClass: string;
}

export const ENGINES: Record<EngineId, EngineVisual> = {
  direct: {
    id: "direct",
    label: "Direct",
    icon: MessageSquare,
    color: "#3b82f6", // Blue
    foreground: "#1d4ed8",
    badgeClass: "text-blue-500 dark:text-blue-400",
  },
  opencode: {
    id: "opencode",
    label: "Code",
    icon: Terminal,
    color: "#10b981", // Emerald
    foreground: "#047857",
    badgeClass: "text-emerald-500 dark:text-emerald-400",
  },
};
