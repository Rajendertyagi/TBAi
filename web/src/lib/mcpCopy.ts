// Single source of truth for MCP failure-reason UI copy.
//
// The backend classifies failures (`McpFailureReason`); this module maps each
// reason to the short truthful sentence the MCP panel shows above the raw
// error text. Pure functions — covered by unit tests. No secrets here.

import type { McpFailureReason } from "../types";

/** Short machine-derived reason line for a failed MCP server or test. */
export function failureCopy(reason: McpFailureReason | undefined): string | undefined {
  switch (reason) {
    case "unreachable":
      return "Cannot reach the server — is the service running?";
    case "auth_required":
      return "Authentication required — enter a credential below";
    case "auth_failed":
      return "Authentication failed — check the stored credential";
    case "incompatible_response":
      return "Endpoint did not return an SSE stream — confirm the URL points at an MCP SSE endpoint";
    case "timeout":
      return "Connection timed out";
    case "protocol_error":
      return "Protocol/transport problem — see detail below";
    case "unknown":
    case undefined:
      return undefined;
  }
}

/** Placeholder for the credential input, per auth type. Never a value. */
export function authPlaceholder(authType: string): string {
  switch (authType) {
    case "basic":
      return "user:password";
    case "oauth":
      return "OAuth access token";
    default:
      return "Paste the bearer token";
  }
}
