// Counts how many distinct instances of a subtree have mounted (TC-761), into
// window.__mounts[id]. StrictMode's simulated remount reuses the instance, so a
// subtree that stays mounted reads 1; one the shell re-parents or remounts reads
// more. `__mountsActive[id]` is how many are mounted right now.
import { useEffect, useState, type ReactNode } from "react";

declare global {
  interface Window {
    __mounts?: Record<string, number>;
    __mountsActive?: Record<string, number>;
  }
}

const instances = new Map<string, Set<object>>();

export function MountProbe({ id, children }: { id: string; children: ReactNode }) {
  const [instance] = useState(() => ({}));
  useEffect(() => {
    let seen = instances.get(id);
    if (!seen) {
      seen = new Set();
      instances.set(id, seen);
    }
    seen.add(instance);
    window.__mounts = { ...window.__mounts, [id]: seen.size };
    window.__mountsActive = { ...window.__mountsActive, [id]: (window.__mountsActive?.[id] ?? 0) + 1 };
    return () => {
      window.__mountsActive = { ...window.__mountsActive, [id]: (window.__mountsActive?.[id] ?? 1) - 1 };
    };
  }, [id, instance]);
  return <>{children}</>;
}
