import { useEffect, useRef } from "react";
import {
  acquireCapabilities,
  buildOpenCodeThinkingOptions,
  normalizeOpenCodeCapabilities,
  readOpenCodeCapabilities,
  releaseCapabilities,
  resetCapabilitiesStoreForTests,
  useCapabilitiesStore,
  type NormalizedOpenCodeCapabilities,
  type OpenCodeAgentOption,
  type OpenCodeCapabilities,
  type OpenCodeDefaultModel,
  type OpenCodeModelOption,
  type OpenCodeThinkingOption,
} from "./capabilitiesStore";

export {
  buildOpenCodeThinkingOptions,
  normalizeOpenCodeCapabilities,
  readOpenCodeCapabilities,
  resetCapabilitiesStoreForTests,
};
export type {
  NormalizedOpenCodeCapabilities,
  OpenCodeAgentOption,
  OpenCodeCapabilities,
  OpenCodeDefaultModel,
  OpenCodeModelOption,
  OpenCodeThinkingOption,
};

/**
 * Live-queries the managed OpenCode server for its available agents and models.
 * Pass `enabled = false` (e.g. when the Direct engine is selected) to skip the
 * request entirely so the server is not started unnecessarily. Every value comes
 * from the server — nothing is hardcoded.
 *
 * State is shared across all enabled consumers: simultaneous mounts produce one
 * request, recovery epochs trigger one authoritative refresh for active
 * consumers, and failed refreshes retain the last successful catalogue.
 */
export function useOpenCodeCapabilities(enabled = true) {
  const agents = useCapabilitiesStore((s) => s.agents);
  const models = useCapabilitiesStore((s) => s.models);
  const defaultModel = useCapabilitiesStore((s) => s.defaultModel);
  const isLoading = useCapabilitiesStore((s) => s.isLoading);
  const error = useCapabilitiesStore((s) => s.error);
  const acquiredRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      if (acquiredRef.current) {
        acquiredRef.current = false;
        releaseCapabilities();
      }
      return;
    }
    if (!acquiredRef.current) {
      acquiredRef.current = true;
      acquireCapabilities();
    }
    return () => {
      if (acquiredRef.current) {
        acquiredRef.current = false;
        releaseCapabilities();
      }
    };
  }, [enabled]);

  if (!enabled) {
    return {
      agents: [] as OpenCodeAgentOption[],
      models: [] as OpenCodeModelOption[],
      defaultModel: undefined as OpenCodeDefaultModel | undefined,
      isLoading: false,
      error: null as string | null,
    };
  }

  return { agents, models, defaultModel, isLoading, error };
}
