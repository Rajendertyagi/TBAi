/**
 * Stand-in for the SIDECAR process, for the descendant-cleanup characterization.
 *
 * It spawns one stdio MCP child through the REAL `mcpManager` — the same code
 * the shipped sidecar runs when a configured MCP server connects — and then
 * waits to be killed. The parent kills it the way Tauri's forced fallback does:
 * `Child::kill()` on the sidecar alone (src-tauri/src/main.rs), with no process
 * group, no job object, and no descendant handling anywhere in `src/`.
 *
 * The question the parent answers: does that MCP child outlive its parent?
 */
if (!process.env.DATA_DIR) {
  console.error(
    "DESCENDANT_FIXTURE_REFUSED: DATA_DIR must be set (tests inherit it from tests/setup.ts)",
  );
  process.exit(3);
}

const marker = process.env.TBAI_DESCENDANT_MARKER ?? "";
const ready = process.env.TBAI_DESCENDANT_READY ?? "";
const probeServer = process.env.TBAI_DESCENDANT_PROBE ?? "";
if (!marker || !ready || !probeServer) {
  console.error("DESCENDANT_FIXTURE_REFUSED: marker, ready and probe paths are required");
  process.exit(3);
}

// Module marker: the runtime imports below are deferred until after the guard
// above, and a file with no static import/export is a script to TypeScript.
export {};

const { mcpManager } = await import("../../src/services/mcp/manager.ts");
const { logger } = await import("../../src/lib/logger.ts");

logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });

const created = mcpManager.createConfig({
  name: "descendant-probe",
  transport: "stdio",
  command: "bun",
  args: [probeServer, marker],
  enabled: true,
  autoConnect: false,
});

// The handshake stays pending forever (the child never answers), which is fine:
// this fixture cares about process lifetime, not about completing MCP init.
void mcpManager.connect(created.id);

// Announce readiness only once the child has reported its own port.
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  if (await Bun.file(marker).exists()) {
    await Bun.write(ready, "ready");
    break;
  }
  await Bun.sleep(20);
}

// Two behaviours, so the characterization can contrast them:
//   "wait"     - the forced-kill case: wait to be killed, running no cleanup.
//   "graceful" - the shipped shutdown path: disconnectAll() closes every MCP
//                transport, which is what the sidecar does on a graceful exit.
if (process.env.TBAI_DESCENDANT_MODE === "graceful") {
  await mcpManager.disconnectAll();
  console.log("DESCENDANT_GRACEFUL_DONE");
  process.exit(0);
}

// Wait to be killed.
await new Promise(() => {});
