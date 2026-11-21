// TC-3547: the one pending consent question. The SDK's `onRegistryPublishConsent` callback lands here; the dialog
// (shell/RegistryConsentDialog.tsx) shows it and answers it. Plain module state with a subscription, because the SDK
// calls the callback from outside React.
import type { RegistryPublishPreview } from "./adapter";
import { registryDismissedStore, type DismissedStore } from "./dismissed";

interface Pending {
  readonly preview: RegistryPublishPreview;
  readonly promise: Promise<boolean>;
  readonly resolve: (approved: boolean) => void;
  readonly reject: (reason: Error) => void;
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
 * The SDK callback. Resolves true on "Publish and continue", false on the "Not now" button and on sign-out. It REJECTS
 * (the SDK reads that as declined, and writes no "Not now" flag) when no answer was given: nothing to show (no dialog
 * mounted, or a preview missing a field) or the dialog was dismissed by Escape or a tap outside. A second question
 * while one is open joins the first.
 */
export function requestRegistryConsent(preview: RegistryPublishPreview): Promise<boolean> {
  if (hosts === 0) return Promise.reject(new Error("Registry consent has no dialog to show it"));
  if (PREVIEW_KEYS.some((key) => typeof preview?.[key] !== "string" || preview[key] === "")) {
    return Promise.reject(new Error("Registry consent preview is incomplete"));
  }
  if (pending) return pending.promise;
  let resolve!: (approved: boolean) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
  pending = { preview, promise, resolve, reject };
  notify();
  return promise;
}

/** The person's answer. Safe to call twice: only the first counts. */
export function answerRegistryConsent(approved: boolean): void {
  const current = pending;
  if (!current) return;
  pending = null;
  current.resolve(approved);
  notify();
}

/**
 * The "Not now" button: remember it for this owner (dismissed.ts), then answer false. Only this path writes the answer;
 * Escape, a tap outside and sign-out do not.
 */
export function declineRegistryConsent(store: DismissedStore = registryDismissedStore): void {
  const current = pending;
  if (!current) return;
  store.write(current.preview.subject);
  answerRegistryConsent(false);
}

/**
 * Escape or a tap outside: close the dialog and THROW, so the SDK treats it as declined and stores nothing. An accidental
 * dismiss must not persist "Not now"; only the button answers false. Does nothing once the question is answered.
 */
export function dismissRegistryConsent(): void {
  const current = pending;
  if (!current) return;
  pending = null;
  current.reject(new Error("Registry consent dismissed without an answer"));
  notify();
}

/** Sign-out: close the dialog and answer false (not a throw, so the SDK settles normally). Writes nothing: nobody said Not now. */
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
