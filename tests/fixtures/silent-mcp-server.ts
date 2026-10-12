/**
 * An MCP stdio child that reports when it has RECEIVED the client's request,
 * and then never answers.
 *
 * Purpose: hold a `connect()` attempt at its `client.connect()` boundary for a
 * window the TEST controls, so an interrupt can be placed exactly there.
 *
 * Two markers, because "the attempt is in flight" has two distinct meanings and
 * only the second one is the boundary under test:
 *
 *   - `spawned`  - the process is running. Not enough: `connect()` sets
 *     `status: "connecting"` before it builds the transport, so interrupting at
 *     this point races the spawn. Closing a transport that has not finished
 *     opening leaves the SDK's `connect()` promise pending forever.
 *   - `requested` - the child has read bytes from stdin, i.e. the client has
 *     sent `initialize` and is waiting for a reply. This is the handshake in
 *     flight, and it is where a real interrupt lands.
 *
 * Never writes to stdout: the MCP stdio framing lives there, and a stray byte
 * would be parsed as a protocol message instead of leaving the handshake open.
 */
import { unlinkSync } from "node:fs";

function clearMarker(name: string): void {
  const path = process.env[`TBAI_SILENT_MCP_${name}`];
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* first run: nothing to clear */
  }
}

const spawnedMarker = process.env.TBAI_SILENT_MCP_SPAWNED;
const requestedMarker = process.env.TBAI_SILENT_MCP_REQUESTED;

clearMarker("SPAWNED");
clearMarker("REQUESTED");
if (spawnedMarker) await Bun.write(spawnedMarker, "spawned");

// Two behaviours, selected by whether a `requested` marker was supplied.
//
// WITH a requested marker: read stdin, announce arrival, stay silent. The client
// has sent `initialize` and is waiting for a reply - the handshake is in flight.
//
// WITHOUT one: do not touch stdin at all. The bytes stay buffered in the pipe
// and the SDK's close settles far more slowly, which is what a case needs when
// it wants a prior connection whose `client.close()` is measurably SLOW, so it
// can park a replacement attempt on that close and let something else resolve
// first. Both behaviours were measured before relying on the difference.
//
// The reader API rather than `for await`: `for await` over a ReadableStream
// needs `DOM.AsyncIterable`, which the test projects deliberately do not enable
// (see `tests/harness/opencodeRuntimeHarness.ts` for the same decision).
if (requestedMarker) {
  const reader = Bun.stdin.stream().getReader();
  const first = await reader.read();
  if (!first.done) await Bun.write(requestedMarker, "requested");
}

await new Promise(() => {});
