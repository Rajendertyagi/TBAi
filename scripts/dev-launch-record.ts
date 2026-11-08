/**
 * The development launch record: the per-launch identity the Tauri shell and
 * the backend share.
 *
 * ## Why this exists
 *
 * `tauri dev` starts the backend through `beforeDevCommand` and then attaches to
 * whatever answers `build.devUrl`. That attach used to accept ANY instance id,
 * so a stale backend from an earlier run - or another checkout's backend - on
 * the same port satisfied readiness, and the window then talked to a process
 * this launch never started. The port cannot distinguish them; only an identity
 * minted by THIS launch can.
 *
 * So one process mints a UUID per launch, writes it here, and hands it to the
 * backend as `TBAI_INSTANCE_ID` (`src/services/server-listener.ts` reads it and
 * serves it from `GET /api/server/instance`). The Rust shell reads this same
 * file in development and accepts only an exact match; anything else is an
 * explicit, diagnosed failure instead of a silent attach.
 *
 * ## The file contract (shared with `src-tauri/src/main.rs`)
 *
 * - one line: the instance id, with a trailing newline;
 * - the reader trims it, so the newline is tolerated, not required;
 * - the path is `<DATA_DIR>/dev-instance-id`, where `DATA_DIR` is the SAME
 *   value the backend uses - imported below, never recomputed here.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../src/config/data-dir";

/** File name, shared with the Rust reader. */
export const DEV_INSTANCE_FILE_NAME = "dev-instance-id";

/** The data directory the backend will use for this launch. */
export function devDataDir(): string {
  return DATA_DIR;
}

/**
 * Mints this launch's identity, records it, and returns it.
 *
 * The record is written BEFORE the backend starts, so by the time
 * `build.devUrl` answers the file already exists. A reader that finds no record
 * is therefore reporting a launch that never went through the launcher - not a
 * race with a slow writer.
 */
export function writeDevLaunchRecord(
  dataDir: string = devDataDir(),
  instanceId: string = randomUUID(),
): { instanceId: string; file: string } {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DEV_INSTANCE_FILE_NAME);
  fs.writeFileSync(file, `${instanceId}\n`, "utf8");
  return { instanceId, file };
}
