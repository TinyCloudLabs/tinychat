export interface AccountContext {
  did: string;
  spaceId: string;
  generation: number;
}

let generation = 0;

/** Call on every sign-in and sign-out, before starting another account's work. */
export function advanceAccountGeneration(): number {
  return ++generation;
}

export function currentAccountGeneration(): number {
  return generation;
}

let mountedAccount: { did: string } | null = null;

/** Bound to the authenticated saver mount, not the backend JWT's lifetime. */
export function mountVoiceNoteAccount(did: string): () => void {
  const account = { did };
  mountedAccount = account;
  return () => { if (mountedAccount === account) mountedAccount = null; };
}

export function isVoiceNoteAccountMounted(did: string): boolean {
  return mountedAccount?.did === did;
}

export class StaleAccountContext extends Error {
  constructor() { super("The account changed while this voice note was being saved"); }
}

export function assertCurrent(ctx: AccountContext): void {
  if (ctx.generation !== generation) throw new StaleAccountContext();
}
