import type { SessionStore } from "@tinyboilerplate/client";
import { NATIVE_BEARER_RECOVERY_RETRY } from "./openkeyNativeStrings";

type ClearableSession = Pick<SessionStore, "clear">;
type RenewableSession = Pick<SessionStore, "getToken" | "isExpired">;
type SessionSignedOutHook = {
  handoff: () => Promise<boolean>;
  onCleared?: () => void;
  renew?: () => Promise<void>;
  recoverLease?: () => Promise<void> | undefined;
};
const hooks = new WeakMap<object, SessionSignedOutHook>();
const pending = new WeakMap<object, Promise<boolean>>();
const renewals = new WeakMap<object, Promise<void>>();

/**
 * Auth clients share the app's durable native handoff before discarding a bearer session. `renew`, when the app has
 * one, is its own session renewal, tried once before a rejected bearer signs the user out.
 */
export function registerSessionSignedOutHook(
  session: object,
  handoff: () => Promise<boolean>,
  onCleared?: () => void,
  renew?: () => Promise<void>,
  recoverLease?: SessionSignedOutHook["recoverLease"],
): () => void {
  const hook = { handoff, onCleared, renew, recoverLease };
  hooks.set(session, hook);
  return () => { if (hooks.get(session) === hook) hooks.delete(session); };
}

/**
 * One renewal attempt after the backend refused `rejectedToken`: the bearer it leaves, when that is a different,
 * unexpired one, else null (no renewal registered, it failed, or it left the same bearer). Overlapping callers share
 * one attempt.
 */
export async function renewSessionOnce(session: RenewableSession, rejectedToken: string): Promise<string | null> {
  const renew = hooks.get(session)?.renew;
  if (renew) {
    let attempt = renewals.get(session);
    if (!attempt) {
      attempt = renew();
      renewals.set(session, attempt);
      void attempt.finally(() => { if (renewals.get(session) === attempt) renewals.delete(session); })
        .catch(() => undefined);
    }
    try { await attempt; } catch { /* Not renewed: the bearer below decides. */ }
  }
  const token = session.getToken();
  return token && token !== rejectedToken && !session.isExpired() ? token : null;
}

export async function clearSessionAfterHandoff(session: ClearableSession): Promise<void> {
  const hook = hooks.get(session);
  if (hook) {
    // A leased native session has its own terminal node verdict and outage retry.
    const recovery = hook.recoverLease?.();
    if (recovery) {
      await recovery;
      throw new Error(NATIVE_BEARER_RECOVERY_RETRY);
    }
    let transition = pending.get(session);
    if (!transition) {
      transition = hook.handoff();
      pending.set(session, transition);
      void transition.finally(() => { if (pending.get(session) === transition) pending.delete(session); })
        .catch(() => undefined);
    }
    if (!await transition) throw new Error("Couldn't stop voice recording for this account on this phone, so you're still signed in. Try again.");
  }
  session.clear();
  hook?.onCleared?.();
}
