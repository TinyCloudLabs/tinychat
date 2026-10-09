import type { SessionStore } from "@tinyboilerplate/client";
import { captureEngineAvailable } from "./voiceNotes/captureEngine";

type ClearableSession = Pick<SessionStore, "clear">;
const hooks = new WeakMap<object, () => Promise<boolean>>();

/** Auth clients share the app's durable native handoff before discarding a bearer session. */
export function registerSessionSignedOutHook(session: object, hook: () => Promise<boolean>): () => void {
  hooks.set(session, hook);
  return () => { if (hooks.get(session) === hook) hooks.delete(session); };
}

export async function clearSessionAfterHandoff(session: ClearableSession): Promise<void> {
  const handoff = hooks.get(session);
  if (!handoff && captureEngineAvailable()) throw new Error("Recording account handoff is not ready. Session was kept.");
  if (handoff && !await handoff()) throw new Error("Couldn't update this phone's recording account. Session was kept.");
  session.clear();
}
