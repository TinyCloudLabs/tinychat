import { useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appLock, biometryName, useAppLock, type AppLock } from "@/lib/appLock";
import { APP_NAME } from "@/lib/homeSite";

/**
 * The lock screen (TC-2738), over everything while the app is locked. The app
 * underneath stays mounted and keeps loading, and #root is inert, so unlocking
 * shows it at once and nothing behind the lock is reachable.
 */
export function AppLockGate({ lock = appLock() }: { lock?: AppLock }) {
  const { state, device, supported } = useAppLock(lock);
  useEffect(() => { void lock.start(); }, [lock]);
  useLayoutEffect(() => {
    const root = document.getElementById("root");
    if (!state.locked || !root) return;
    root.setAttribute("inert", "");
    return () => root.removeAttribute("inert");
  }, [state.locked]);
  if (!supported || !state.locked) return null;
  const method = device ? `Unlock with ${biometryName(device)}` : "Unlock";
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      data-testid="app-lock"
      // Above the recorder sheet and every dialog. A modal Radix dialog underneath turns off pointer events on the
      // body and minimises itself on an outside press: take pointer events back, and keep presses here.
      style={{ pointerEvents: "auto" }}
      onPointerDown={(event) => event.stopPropagation()}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-background px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-center text-foreground"
    >
      <LockIcon aria-hidden className="size-8 text-muted-foreground" />
      <h1 id="app-lock-title" className="text-lg font-semibold tracking-tight">{APP_NAME} is locked</h1>
      {state.failure === "failed" && (
        <p role="alert" className="max-w-xs text-sm text-muted-foreground">That didn't unlock it. Try again.</p>
      )}
      <Button type="button" onClick={() => void lock.retry()} disabled={state.authenticating}>
        {state.authenticating ? "Unlocking…" : method}
      </Button>
    </div>,
    document.body,
  );
}
