import type { SessionStore } from "@tinyboilerplate/client";

type ClearableSession = Pick<SessionStore, "clear">;
const hooks = new WeakMap<object, () => Promise<boolean>>();
const pending = new WeakMap<object, Promise<boolean>>();

/** Auth clients share the app's durable native handoff before discarding a bearer session. */
export function registerSessionSignedOutHook(session: object, hook: () => Promise<boolean>): () => void {
  hooks.set(session, hook);
  return () => { if (hooks.get(session) === hook) hooks.delete(session); };
}

export async function clearSessionAfterHandoff(session: ClearableSession): Promise<void> {
  const handoff = hooks.get(session);
  if (handoff) {
    let transition = pending.get(session);
    if (!transition) {
      transition = handoff();
      pending.set(session, transition);
      void transition.finally(() => { if (pending.get(session) === transition) pending.delete(session); })
        .catch(() => undefined);
    }
    if (!await transition) throw new Error("Couldn't update this phone's recording account. Session was kept.");
  }
  session.clear();
}
