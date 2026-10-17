/**
 * Desktop stdin shutdown intake (proposal D-1 Option C).
 *
 * The Tauri shell writes a newline-terminated `{"type":"shutdown"}` line to the
 * sidecar's stdin (`src-tauri/src/main.rs` `quit_owned`), then waits up to
 * 3,000 ms for the child to exit before falling back to `child.kill()`.
 *
 * This module owns only the stdin protocol: it reads JSON command lines and
 * invokes the caller's `onShutdown` once per `shutdown` command. The caller
 * (the entry point) owns what shutdown means — resolving the active listener
 * and running the canonical spine — so this module has no dependency on
 * `server.ts` and stays testable without booting the application.
 *
 * EOF is deliberately NOT a shutdown trigger: it can occur during normal
 * operation (e.g. a Tauri crash) and must not cause a spurious shutdown. Only
 * an explicit `shutdown` line triggers it.
 */

export interface DesktopStdinShutdownOptions {
  /**
   * Invoked once per received `{"type":"shutdown"}` line. The caller resolves
   * the live server and runs the shutdown spine; this module does not.
   */
  onShutdown: () => void;
}

/**
 * Start reading command lines from the sidecar's stdin. Returns immediately —
 * the reader runs in the background for the life of the process. Malformed
 * lines are ignored; blank lines are skipped.
 */
export function installDesktopStdinShutdown(options: DesktopStdinShutdownOptions): void {
  const reader = Bun.stdin.stream().getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break; // EOF — never a shutdown trigger (see header)
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as { type?: string };
          if (msg.type === "shutdown") options.onShutdown();
        } catch {
          /* malformed line: ignore */
        }
      }
    }
  })();
}
