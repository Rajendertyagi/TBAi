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
  void Bun.write(marker, `${process.pid}:${port}`);
});

// Never exits on its own: the parent decides when this process dies.
await new Promise(() => {});
