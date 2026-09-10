// ── Tool-activity store (session-scoped, per assistant message) ──────
//
// Pub/sub store keyed by assistant message id. Populated in run() via
// onToolActivity (from streamAgentChat), consumed by ToolActivityChip in
// Thread.tsx. Cleared at turn end (stream finish). Mirrors completionStore.ts.

export interface ToolActivity {
  name: string;
  status: "running" | "done" | "error";
  id?: string;
}

const activityMap = new Map<string, ToolActivity>();
const runningMap = new Map<string, Map<string | undefined, ToolActivity>>();
type ActivityListener = (messageId: string, activity: ToolActivity | null) => void;
const activityListeners = new Set<ActivityListener>();

/** Get the latest tool activity for an assistant message id, if any. */
export function getToolActivity(messageId: string): ToolActivity | null {
  return activityMap.get(messageId) ?? null;
}

/** Show each running call, or the latest terminal activity when all are done. */
export function getToolActivities(messageId: string): ToolActivity[] {
  const running = runningMap.get(messageId);
  if (running?.size) return [...running.values()];
  const latest = getToolActivity(messageId);
  return latest ? [latest] : [];
}

/** Record tool activity for a message id and notify subscribers. */
export function setToolActivity(messageId: string, activity: ToolActivity): void {
  activityMap.set(messageId, activity);
  if (activity.status === "running") {
    const running = runningMap.get(messageId) ?? new Map();
    // Legacy frames share one slot and retain their previous overwrite behavior.
    running.set(activity.id, activity);
    runningMap.set(messageId, running);
  } else {
    runningMap.get(messageId)?.delete(activity.id);
  }
  for (const listener of activityListeners) {
    try {
      listener(messageId, activity);
    } catch {
      // a listener throwing must not break the store update
    }
  }
}

/** Clear tool activity for a message id (at turn end) and notify subscribers. */
export function clearToolActivity(messageId: string): void {
  if (!activityMap.has(messageId)) return;
  activityMap.delete(messageId);
  runningMap.delete(messageId);
  for (const listener of activityListeners) {
    try {
      listener(messageId, null);
    } catch {
      // a listener throwing must not break the clear
    }
  }
}

/** Subscribe to tool-activity updates. Returns an unsubscribe fn. */
export function onToolActivityChange(listener: ActivityListener): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}
