// One's new navigation (ONE_NAV_ENABLED): the short note that says an app was pinned or unpinned, from the open app's
// bar or the grid, just above the phone's pill.
import { useEffect, useState } from "react";

const TOAST_MS = 2400;

export function usePinToast(): [message: string | null, show: (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);
  return [message, setMessage];
}

export function PinToast({ message }: { message: string | null }) {
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tc-bottom-chrome,0px)+1rem)] z-40 flex justify-center px-4">
      {message === null ? null : <span className="rounded-full bg-foreground px-4 py-2 text-label font-medium text-background shadow-lg">{message}</span>}
    </div>
  );
}
