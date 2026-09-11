// Bun test preload: isolate the SQLite database AND the tool workspace per
// test run so MCP/provider/conversation/tool tests never touch the
// developer's data/chat.db or workspace/ folder.
import path from "path";
import fs from "fs";
import os from "os";

const dir = path.join(os.tmpdir(), `tbai-test-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

const workdir = path.join(dir, "workspace");
fs.mkdirSync(workdir, { recursive: true });
process.env.WORKSPACE_DIR = workdir;
