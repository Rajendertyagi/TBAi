import { OpenCode } from "@opencode/client";
import { getOpenCodeAuthHeaders, getOpenCodeDirectoryHeaders } from "./runtime";

/**
 * The official OpenCode V2 client bound to one managed server base URL.
 * Every method is promise-based and throws on failure; callers translate the
 * thrown value into TBAi's own error vocabulary through `./errors`.
 */
export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

const transport: typeof globalThis.fetch = globalThis.fetch;

/** Creates an authenticated, optionally directory-scoped native V2 client. */
export function createOpenCodeClient(
  baseUrl: string,
  options: { directory?: string | null } = {},
): OpenCodeClient {
  return OpenCode.make({
    baseUrl,
    headers: {
      ...getOpenCodeAuthHeaders(),
      ...getOpenCodeDirectoryHeaders(options.directory),
    },
    fetch: transport,
  });
}
