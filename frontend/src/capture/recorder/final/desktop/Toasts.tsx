import { useCallback, useEffect, useState } from "react";

const TOAST_MS = 2400;

export interface ToastItem {
  id: number;
  message: string;
}

let nextId = 0;

/** Shows each message for a moment, then drops it. */
export function useToasts(): {
  toasts: readonly ToastItem[];
  show: (message: string) => void;
} {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const show = useCallback(
    (message: string) =>
      setToasts((current) => [...current, { id: nextId++, message }]),
    [],
  );
  const oldest = toasts[0]?.id;
  useEffect(() => {
    if (oldest === undefined) return;
    const timer = setTimeout(
      () => setToasts((current) => current.filter((t) => t.id !== oldest)),
      TOAST_MS,
    );
    return () => clearTimeout(timer);
  }, [oldest]);
  return { toasts, show };
}

/** At the top centre of the main area, so they never cover the controls. */
export function Toasts({ toasts }: { toasts: readonly ToastItem[] }) {
  return (
    <div className="dr-toasts" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className="dr-toast">
          {toast.message}
        </div>
      ))}
    </div>
  );
}
