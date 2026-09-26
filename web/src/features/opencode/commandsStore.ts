import { create } from "zustand";
import { logger } from "../../lib/logger";
import {
  parseCommandFeed,
  type OpenCodeCommand,
} from "./slashCommands";

/**
 * OpenCode's command feed, for the composer's `/` palette.
 *
 * The feed is served by OpenCode itself and reaches the browser through the
 * existing `/api/opencode/*` proxy — there is no TBAi-side route and no
 * hardcoded command list, so a new command or skill shows up without a code
 * change. Follows `quickMessagesStore`'s shape (the project's convention for a
 * server-backed list).
 *
 * Load discipline, borrowed from a sibling implementation that learned it the
 * hard way:
 * - a short TTL so opening the palette repeatedly does not re-fetch;
 * - single-flight, so concurrent opens share one request;
 * - **failure retains the previous list** — a backend outage must never render
 *   as "this project has no commands".
 */

/** Re-fetch only after this long; the feed changes on file edits, not per keystroke. */
const FEED_TTL_MS = 30_000;

/** The proxy path to OpenCode's command endpoint (see routes/opencode.ts). */
export const OPENCODE_COMMANDS_PATH = "/api/opencode/command";

interface CommandsState {
  commands: OpenCodeCommand[];
  loading: boolean;
  error: string | null;
  /** Epoch ms of the last successful load, or 0 when never loaded. */
  loadedAt: number;
  load: (opts?: { force?: boolean }) => Promise<void>;
}

/** In-flight request shared by concurrent callers (single-flight). */
let inFlight: Promise<void> | null = null;

export const useCommandsStore = create<CommandsState>((set, get) => ({
  commands: [],
  loading: false,
  error: null,
  loadedAt: 0,

  load: async (opts) => {
    const { loadedAt, commands } = get();
    const fresh =
      !opts?.force &&
      commands.length > 0 &&
      Date.now() - loadedAt < FEED_TTL_MS;
    if (fresh) return;
    if (inFlight) return inFlight;

    const request = (async () => {
      set({ loading: true });
      try {
        const res = await fetch(OPENCODE_COMMANDS_PATH);
        if (!res.ok) {
          // Non-ok carries no authoritative list: keep the previous one.
          logger.warn("opencode", "command.feed_failed", {
            status: res.status,
            retained: get().commands.length,
          });
          set({ loading: false, error: `Failed to load commands (${res.status})` });
          return;
        }
        const parsed = parseCommandFeed(await res.json().catch(() => null));
        if (parsed.length === 0 && get().commands.length > 0) {
          // 200 with a malformed/empty payload carries no authoritative list:
          // retain the previous one rather than rendering "no commands".
          // Distinct from HTTP/network failure (see `reason`).
          logger.warn("opencode", "command.feed_failed", {
            status: res.status,
            reason: "empty_or_invalid_payload",
            retained: get().commands.length,
          });
          set({ loading: false, error: "Empty or invalid command feed" });
          return;
        }
        set({
          commands: parsed,
          loading: false,
          error: null,
          loadedAt: Date.now(),
        });
        logger.info("opencode", "command.feed_loaded", {
          count: parsed.length,
          commands: parsed.length,
          skills: parsed.filter((c) => c.source === "skill").length,
        });
      } catch (err) {
        // Network failure: existence is UNKNOWN — retain, never report empty.
        logger.warn("opencode", "command.feed_failed", {
          errorType: err instanceof Error ? err.name : typeof err,
          retained: get().commands.length,
        });
        set({
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load commands",
        });
      }
    })();

    inFlight = request;
    try {
      return await request;
    } finally {
      inFlight = null;
    }
  },
}));

/** Test-only: drop the cached freshness so the next `load` re-fetches. */
export function resetCommandsFeedForTests(): void {
  inFlight = null;
  useCommandsStore.setState({ commands: [], loading: false, error: null, loadedAt: 0 });
}
