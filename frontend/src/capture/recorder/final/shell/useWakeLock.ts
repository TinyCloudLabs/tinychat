import { useEffect } from "react";

interface SentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}
export interface WakeLockEnv {
  navigator: { wakeLock?: { request(type: "screen"): Promise<SentinelLike> } };
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  warn(message: string, caught?: unknown): void;
}

const browserEnv = (): WakeLockEnv => ({
  navigator: navigator as unknown as WakeLockEnv["navigator"],
  document,
  warn: (message, caught) => console.warn(`[Recorder] ${message}`, ...(caught === undefined ? [] : [caught])),
});

/**
 * Holds a screen wake lock until the returned release is called. The browser drops it when the
 * tab is hidden, so it is taken again when the tab is visible. Failures are warnings, never throws.
 */
export function holdWakeLock(env: WakeLockEnv): () => void {
  let sentinel: SentinelLike | null = null;
  let requesting = false;
  let active = true;
  let warnedUnsupported = false;

  const release = (held: SentinelLike) => {
    held.release().catch((caught: unknown) => env.warn("Could not release the screen wake lock", caught));
  };
  const acquire = () => {
    if (!active || sentinel || requesting) return;
    const api = env.navigator.wakeLock;
    if (!api) {
      if (!warnedUnsupported) env.warn("This browser has no screen wake lock; the screen may sleep while recording");
      warnedUnsupported = true;
      return;
    }
    if (env.document.visibilityState !== "visible") return;
    requesting = true;
    api.request("screen").then(
      (held) => {
        requesting = false;
        if (!active) return release(held);
        sentinel = held;
        held.addEventListener("release", () => {
          if (sentinel === held) sentinel = null;
        });
      },
      (caught: unknown) => {
        requesting = false;
        env.warn("Could not hold the screen wake lock; the screen may sleep while recording", caught);
      },
    );
  };
  const onVisibility = () => {
    if (env.document.visibilityState === "visible") acquire();
  };

  env.document.addEventListener("visibilitychange", onVisibility);
  acquire();
  return () => {
    active = false;
    env.document.removeEventListener("visibilitychange", onVisibility);
    if (sentinel) release(sentinel);
    sentinel = null;
  };
}

/** Web only: the screen stays on while `wanted` (recording, not paused). */
export function useWakeLock(wanted: boolean, env?: WakeLockEnv): void {
  useEffect(() => (wanted ? holdWakeLock(env ?? browserEnv()) : undefined), [wanted, env]);
}
