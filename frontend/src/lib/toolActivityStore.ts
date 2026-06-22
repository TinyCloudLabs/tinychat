// ── Tool-activity store (session-scoped, per assistant message) ──────
//
// Pub/sub store keyed by assistant message id. Populated in run() via
// onToolActivity (from streamAgentChat), consumed by ToolActivityChip in
// Thread.tsx. Cleared at turn end (stream finish). Mirrors completionStore.ts.

export interface ToolActivity {
  name: string;
  status: "running" | "done" | "error";
}

const activityMap = new Map<string, ToolActivity>();
type ActivityListener = (messageId: string, activity: ToolActivity | null) => void;
const activityListeners = new Set<ActivityListener>();

/** Get the latest tool activity for an assistant message id, if any. */
export function getToolActivity(messageId: string): ToolActivity | null {
  return activityMap.get(messageId) ?? null;
}

/** Record tool activity for a message id and notify subscribers. */
export function setToolActivity(messageId: string, activity: ToolActivity): void {
  activityMap.set(messageId, activity);
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
