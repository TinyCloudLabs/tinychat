/** Tells the rest of the app that a source's saved meetings were just deleted, so lists can drop them at once. */
export const CONNECTOR_PURGED_EVENT = "tinychat:connector-purged";

export function announceConnectorPurged(source: string): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return;
  window.dispatchEvent(new CustomEvent(CONNECTOR_PURGED_EVENT, { detail: { source } }));
}

/** Calls `handler` for each purge of `source`; returns the unsubscribe function. */
export function onConnectorPurged(source: string, handler: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const listener = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    if ((detail as { source?: unknown } | null)?.source === source) handler();
  };
  window.addEventListener(CONNECTOR_PURGED_EVENT, listener);
  return () => window.removeEventListener(CONNECTOR_PURGED_EVENT, listener);
}
