import { useEffect, useState, type FC } from "react";
import { useMessage } from "@assistant-ui/react";
import {
  getToolActivity,
  onToolActivityChange,
  type ToolActivity,
} from "../lib/toolActivityStore";

function labelForActivity(activity: ToolActivity): string {
  const { name, status } = activity;
  const isDone = status === "done";
  const isError = status === "error";

  switch (name.toLowerCase()) {
    case "web_search":
      return isDone ? "Searched the web" : isError ? "Search failed" : "Searching the web…";
    default:
      return isDone ? "Tool done" : isError ? "Tool failed" : "Running tool…";
  }
}

/**
 * Inline status chip for the active tool call on an assistant message.
 * Reads toolActivityStore keyed by the message id; clears automatically when
 * the turn ends (clearToolActivity in run()). Styled with existing receipt-chip
 * tokens — no new aesthetic introduced.
 */
export const ToolActivityChip: FC = () => {
  const messageId = useMessage((m) => m.id);
  const [activity, setActivity] = useState<ToolActivity | null>(
    () => getToolActivity(messageId),
  );

  useEffect(() => {
    // Re-check on mount in case the activity arrived between render + effect.
    setActivity(getToolActivity(messageId));
    return onToolActivityChange((id, a) => {
      if (id === messageId) setActivity(a);
    });
  }, [messageId]);

  if (!activity) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="mt-1 text-[11px] leading-none text-muted-foreground/70"
    >
      {labelForActivity(activity)}
    </div>
  );
};
