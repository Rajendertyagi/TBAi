/**
 * Publishing small records (JSON handshakes, marker files) that another process
 * polls for.
 *
 * ## Why existence is not enough
 *
 * `writeFileSync` and `Bun.write` create - and truncate - the destination
 * BEFORE they write the bytes into it. Every reader in these suites polls for
 * the file to EXIST and then reads it once, which is the natural thing to write
 * and the wrong contract: in that window the file is empty.
 *
 * MEASURED 2026-10-26 on this machine: a probe that mirrors
 * `startLifecycle` in `tests/integration/opencode/process-ownership.test.ts`
 * observed the grandchild marker empty in **3 of 40** starts (and 2 of 30 in an
 * earlier sample), with the content appearing shortly afterwards and the server
 * answering. The same window made that suite fail 2 of 28 runs on its first
 * liveness assertion: the recorded port was `""`, so no request could even be
 * formed.
 *
 * Writing a sibling file and renaming it into place removes the window: the
 * destination either does not exist yet or holds every byte. Readers keep
 * polling for existence, which becomes a complete signal.
 */
import fs from "node:fs";

/**
 * Writes `contents` to `filePath` atomically, replacing any existing file.
 *
 * Returns nothing. Throws only when the filesystem refuses the write or the
 * rename; a leftover temporary sibling is impossible on the success path.
 */
export function writeRecordAtomically(filePath: string, contents: string): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, filePath);
}
