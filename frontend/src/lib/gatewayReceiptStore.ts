const verifiedReplies = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

export function getGatewayReceiptVerified(messageId: string): boolean {
  return verifiedReplies.has(messageId);
}

export function setGatewayReceiptVerified(messageId: string): void {
  if (!messageId || verifiedReplies.has(messageId)) return;
  verifiedReplies.add(messageId);
  listeners.get(messageId)?.forEach((listener) => listener());
}

export function clearGatewayReceipt(messageId: string): void {
  if (!verifiedReplies.delete(messageId)) return;
  listeners.get(messageId)?.forEach((listener) => listener());
}

export function onGatewayReceipt(messageId: string, listener: () => void): () => void {
  let messageListeners = listeners.get(messageId);
  if (!messageListeners) {
    messageListeners = new Set();
    listeners.set(messageId, messageListeners);
  }
  messageListeners.add(listener);
  return () => {
    messageListeners?.delete(listener);
    if (messageListeners?.size === 0) listeners.delete(messageId);
  };
}
