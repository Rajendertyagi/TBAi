import { AuiProvider, AuiConfig } from "@assistant-ui/react";
import type { ReactNode } from "react";

const emptyConfig = AuiConfig({});

/**
 * Resets ambient assistant-ui context so child OpenCode thread list runtimes
 * create an independent top-level runtime rather than degrading to a child no-op.
 */
export function OpenCodeIsolationBoundary({ children }: { children: ReactNode }) {
  return <AuiProvider extends={null} config={emptyConfig}>{children}</AuiProvider>;
}
