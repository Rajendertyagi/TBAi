import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { BackendToolView } from "../filesystem/ui";

type AnyArgs = Record<string, unknown>;
type AnyResult = unknown;
type AnyProps = ToolCallMessagePartProps<AnyArgs, AnyResult>;

type TodoItem = { id: string; text: string; done: boolean; position: number };

/**
 * Render-only view of the todo tool result. The model drives the list via tool
 * calls; this card never mutates state client-side. Reuses TBAi's existing
 * todo visual language (status icon + strike-through when done).
 */
function todoSummary(result: AnyResult) {
  const items = (result as { items?: TodoItem[] } | undefined)?.items ?? [];
  if (items.length === 0) return <span className="text-muted-foreground">No items.</span>;
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2">
          {item.done ? (
            <CheckCircle2Icon className="h-3.5 w-3.5 shrink-0 text-green-500" />
          ) : (
            <CircleIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
          )}
          <span className={item.done ? "line-through text-muted-foreground/60" : ""}>
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const TodoToolUI: ToolCallMessagePartComponent = (p: AnyProps) => (
  <BackendToolView
    title={`todo · ${String(p.args.action ?? "")}`}
    args={p.args}
    result={p.result}
    status={p.status}
    approval={p.approval}
    respondToApproval={p.respondToApproval}
    runningLabel="Updating list…"
    summarize={todoSummary}
  />
);
