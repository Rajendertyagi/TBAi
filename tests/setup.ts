// Bun test preload: isolate the SQLite database AND the tool workspace per
// test file, so MCP/provider/conversation/tool tests never touch the
// developer's data/chat.db or workspace/ folder - and never observe another
// test file's rows.
//
// `bun test` runs every file in one process. The isolation therefore comes
// from the harness flag `--isolate` (a fresh global object AND a fresh module
// registry per file, with this preload re-run per file and `process.argv[1]`
// pointing at that file). Given that, the sandbox is resolved per file.
// See tests/test-sandbox.ts for the identity contract and the fallback.
import fs from "fs";

import { collectStaleSandboxes, resolveTestSandbox } from "./test-sandbox";

collectStaleSandboxes();

const sandbox = resolveTestSandbox(process.argv[1], process.pid);

// Isolation was refused. That is safe - the run falls back to one shared
// per-run sandbox, exactly the pre-isolation behaviour, and never touches a
// real install - but it must never be silent, because the suite then goes on
// to pass while quietly sharing one database and one module registry again.
// Under a correct harness this branch never runs; when it does, per line per
// file is the right amount of noise.
if (!sandbox.isolated) {
  process.stderr.write(
    `[test-sandbox] REFUSING per-file isolation: ${sandbox.fallbackReason}. ` +
      `Falling back to the shared run root ${sandbox.runRoot}; every collected ` +
      `test file will share one SQLite database and one module registry. ` +
      `This is a harness-contract failure, not a test failure.\n`,
  );
}

fs.mkdirSync(sandbox.dataDir, { recursive: true });
process.env.DATA_DIR = sandbox.dataDir;

fs.mkdirSync(sandbox.workspaceDir, { recursive: true });
process.env.WORKSPACE_DIR = sandbox.workspaceDir;