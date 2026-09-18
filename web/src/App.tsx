import { RouterProvider } from "react-router/dom";
import { router } from "./app/router";
import { ElicitationModal } from "./components/ElicitationModal";

/**
 * Application root: hash router plus the runtime-independent elicitation
 * modal (MCP approvals are global across surfaces). Assistant runtimes are
 * branch-scoped, never app-wide: the chat branch owns its thread-list
 * runtime (`ChatShell`), and the Code branch owns the OpenCode runtime
 * (`CodeShell`). A `useRemoteThreadListRuntime` created under another
 * RemoteThreadListRuntime degrades to a parent-context no-op, so the two
 * must never nest — this split is structural, not stylistic.
 */
export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ElicitationModal />
    </>
  );
}
