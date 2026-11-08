/**
 * Long-lived stdio child for the descendant-cleanup characterization.
 *
 * It holds a listening loopback port and reports `pid:port` to the marker file,
 * so the parent can decide whether this process is still ALIVE by fetching the
 * port. That avoids depending on signal-0 semantics, which differ per platform.
 *
 * It deliberately never writes to stdout: in the characterization it is spawned
 * as an MCP stdio child, where stdout is the protocol channel.
 */
import { createServer } from "node:http";

import { writeRecordAtomically } from "../helpers/atomic-record.ts";

const marker = process.argv[2];
if (!marker) {
  console.error("descendant-probe-server: marker path required");
  process.exit(2);
}

const server = createServer((_req, res) => {
  res.end("alive");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // Published atomically: both readers (`process-ownership.test.ts` and
  // `descendant-cleanup.test.ts`) poll for this file to exist and then read it
  // once. MEASURED 2026-10-26: a plain write left it observable as "" in 3 of
  // 40 starts, which broke the liveness assertion before any request was made.
  writeRecordAtomically(marker, `${process.pid}:${port}`);
});

// Never exits on its own: the parent decides when this process dies.
await new Promise(() => {});
