// Whether a session is open, for UI that lives outside App (the PWA prompts).
// App publishes it; nothing else writes it.
import { useSyncExternalStore } from "react";

let signedIn = false;
const listeners = new Set<() => void>();

export function setSignedIn(next: boolean): void {
  if (signedIn === next) return;
  signedIn = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSignedIn(): boolean {
  return useSyncExternalStore(subscribe, () => signedIn, () => false);
}
