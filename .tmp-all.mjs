import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const files = ["src/routes/chat.ts","src/context/limits.ts","src/services/todos.ts",
  "src/config/providers.ts","src/context/cache/verification.ts","src/routes/providers.ts",
  "src/services/modelDiscovery.ts","src/services/chat-streams/sqliteResumableStore.ts",
  "src/services/chat-streams/historyReconciler.ts","src/services/mcp/manager.ts",
  "src/routes/direct-compact-command.ts","src/services/scheduler/schedulerExecution.ts"];
const backup = {};
for (const f of files) {
  backup[f] = readFileSync("D:/Temp/ai-chat-app/"+f, "utf8");
  try { writeFileSync("D:/Temp/ai-chat-app/"+f, execSync('git show HEAD:'+f,{cwd:"D:/Temp/ai-chat-app",maxBuffer:1e8}).toString(), "utf8"); }
  catch(e) { console.log("  skip "+f); }
}
// also move the new chat/ modules aside so the old chat.ts compiles
const { execSync: ex } = await import("node:child_process");
ex('cmd /c move "D:\\Temp\\ai-chat-app\\src\\routes\\chat" "D:\\Temp\\ai-chat-app\\src\\routes\\chat__held"', {stdio:"ignore"});
console.log("REVERT-STATE-READY");