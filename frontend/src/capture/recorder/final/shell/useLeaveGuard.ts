import { useEffect } from "react";

export interface LeaveGuardTarget {
  addEventListener(type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
  removeEventListener(type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
}

export function leaveGuard(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

/** Web only: the browser asks before the tab closes or reloads, only while `active` (recording or paused). */
export function useLeaveGuard(active: boolean, target?: LeaveGuardTarget): void {
  useEffect(() => {
    if (!active) return;
    const guarded = target ?? window;
    guarded.addEventListener("beforeunload", leaveGuard);
    return () => guarded.removeEventListener("beforeunload", leaveGuard);
  }, [active, target]);
}
