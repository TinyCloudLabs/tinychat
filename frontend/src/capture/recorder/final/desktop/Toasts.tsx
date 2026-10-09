import { useSyncExternalStore } from "react";

const TOAST_MS = 2400;

export interface ToastItem {
  id: number;
  message: string;
}

let nextId = 0;
let toasts: readonly ToastItem[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly ToastItem[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

/** Shows a message at the top centre of the main area for a moment, then drops it. Callable from anywhere. */
export function showToast(message: string): void {
  const id = nextId++;
  publish([...toasts, { id, message }]);
  setTimeout(() => publish(toasts.filter((t) => t.id !== id)), TOAST_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** At the top centre of the main area, so they never cover the controls. */
export function Toasts() {
  const items = useSyncExternalStore(subscribe, () => toasts, () => toasts);
  return (
    <div className="dr-toasts" role="status">
      {items.map((toast) => (
        <div key={toast.id} className="dr-toast">
          {toast.message}
        </div>
      ))}
    </div>
  );
}
