/**
 * Development preload: mint this launch's backend identity before the server
 * module evaluates.
 *
 * `bun --preload ./scripts/dev-instance-preload.ts src/index.ts` runs this module
 * first, so `process.env.TBAI_INSTANCE_ID` is set before
 * `src/services/server-listener.ts` reads it at module scope. It also records the
 * same id in `<DATA_DIR>/dev-instance-id`, which the Tauri shell (`attach_dev_backend`
 * in `src-tauri/src/main.rs`) requires an exact match against.
 *
 * Deliberately NOT a wrapper process: the identity belongs to the process that
 * owns the listener, and an extra parent would add an orphan/kill-forwarding
 * surface to development for no benefit.
 *
 * `beforeDevCommand` is `bun run dev:shell`, which is exactly this preload. A
 * developer who starts the backend with a bare `bun run dev` writes no record,
 * so the shell refuses to attach and says so - it never guesses.
 */
import { writeDevLaunchRecord } from "./dev-launch-record";

const record = writeDevLaunchRecord();
process.env.TBAI_INSTANCE_ID = record.instanceId;
