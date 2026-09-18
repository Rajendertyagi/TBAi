"use client";

import {
  useWelcomeEngineStore,
  type WelcomeEngine,
} from "../state/welcomeEngine";
import { EnginePicker } from "@/components/EnginePicker";

/**
 * Engine switch for the welcome draft surface. A centered Direct/OpenCode
 * pill switch occupying the CodeG agent-selector slot (above the composer).
 * Engine only — agent/model selection lives in the composer's Agent chip.
 * Locked at creation: switching engine clears the agent/model draft pick.
 */
export function WelcomeEnginePicker() {
  const engine = useWelcomeEngineStore((s) => s.engine);
  const setEngine = useWelcomeEngineStore((s) => s.setEngine);
  const handleChange = (next: WelcomeEngine) => setEngine(next);

  return <EnginePicker value={engine} onChange={handleChange} />;
}
