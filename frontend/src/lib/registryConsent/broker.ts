// TC-3547: the one pending consent question. The SDK's `onRegistryPublishConsent` callback lands here; the dialog
// (shell/RegistryConsentDialog.tsx) shows it and answers it. Plain module state with a subscription, because the SDK
// calls the callback from outside React.
import type { RegistryPublishPreview } from "./adapter";

interface Pending {
  readonly preview: RegistryPublishPreview;
  readonly promise: Promise<boolean>;
  readonly resolve: (approved: boolean) => void;
}

let pending: Pending | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

const notify = () => { for (const listener of [...listeners]) listener(); };

export function subscribeRegistryConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The question on screen, or null. A new object only when the question changes (for useSyncExternalStore). */
export function pendingRegistryConsent(): RegistryPublishPreview | null {
  return pending?.preview ?? null;
}

/** The dialog calls this while it is mounted; without one, a question would never be seen or answered. */
export function registerRegistryConsentHost(): () => void {
  hosts += 1;
  return () => { hosts -= 1; };
}

const PREVIEW_KEYS = ["subject", "nodeDid", "nodeOrigin", "space"] as const;

/**
 * The SDK callback. Resolves true on "Publish and continue", false on "Not now", on closing the dialog, and on
 * sign-out. It REJECTS (the SDK reads that as declined, and writes no "Not now" flag) when there is nothing to
 * show: no dialog mounted, or a preview missing a field, so no answer was ever given. A second question while one is
 * open joins the first.
 */
export function requestRegistryConsent(preview: RegistryPublishPreview): Promise<boolean> {
  if (hosts === 0) return Promise.reject(new Error("Registry consent has no dialog to show it"));
  if (PREVIEW_KEYS.some((key) => typeof preview?.[key] !== "string" || preview[key] === "")) {
    return Promise.reject(new Error("Registry consent preview is incomplete"));
  }
  if (pending) return pending.promise;
  let resolve!: (approved: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  pending = { preview, promise, resolve };
  notify();
  return promise;
}

/** The person's answer (or the dialog being dismissed). Safe to call twice: only the first counts. */
export function answerRegistryConsent(approved: boolean): void {
  const current = pending;
  if (!current) return;
  pending = null;
  current.resolve(approved);
  notify();
}

/** Close the dialog and answer false: not a throw, so the SDK settles normally. */
export function cancelPendingRegistryConsent(): void {
  answerRegistryConsent(false);
}

/**
 * Sign-out: start the SDK's sign-out FIRST, then close the question. The SDK's sign-out counter moves when its
 * sign-out starts; an answer that lands before it would let the SDK see the old account still signed in and
 * store "Not now" for a person who never said it. Starting it first makes that answer end as a cancelled flow that writes
 * nothing. Account B never sees account A's dialog either way.
 */
export function startSignOutClosingRegistryConsent<T>(startSignOut: () => T): T {
  try {
    return startSignOut();
  } finally {
    cancelPendingRegistryConsent();
  }
}
