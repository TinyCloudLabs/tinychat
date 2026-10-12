export interface AccountContext {
  did: string;
  spaceId: string;
  generation: number;
}

export interface AccountIdentity {
  did: string;
  spaceId?: string;
}

let generation = 0;
const pausedClients = new WeakSet<object>();
const accountWorkListeners = new Set<() => void>();
const accountGenerationListeners = new Set<(generation: number) => void>();

/** Call on every sign-in and sign-out, before starting another account's work. */
export function advanceAccountGeneration(): number {
  generation++;
  for (const listener of [...accountGenerationListeners]) listener(generation);
  return generation;
}

export function subscribeAccountGeneration(listener: (generation: number) => void): () => void {
  accountGenerationListeners.add(listener);
  return () => { accountGenerationListeners.delete(listener); };
}

export function currentAccountGeneration(): number {
  return generation;
}

/** The save pipeline pauses account-scoped work during sign-out and resumes it on abort. */
export function isAccountWorkAllowed(client: object): boolean {
  return !pausedClients.has(client);
}

export function setAccountWorkPaused(client: object, paused: boolean): void {
  const wasPaused = pausedClients.has(client);
  if (wasPaused === paused) return;
  if (paused) pausedClients.add(client);
  else pausedClients.delete(client);
  for (const listener of [...accountWorkListeners]) listener();
}

export function subscribeAccountWork(listener: () => void): () => void {
  accountWorkListeners.add(listener);
  return () => { accountWorkListeners.delete(listener); };
}

/** Capture the identity and generation before beginning asynchronous work. */
export function captureAccountContext(identity: AccountIdentity): AccountContext {
  return { did: identity.did, spaceId: identity.spaceId ?? "", generation };
}

export function isAccountContextCurrent(ctx: AccountContext, identity: AccountIdentity): boolean {
  return ctx.generation === generation && ctx.did === identity.did && ctx.spaceId === (identity.spaceId ?? "");
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

export function assertAccountContext(ctx: AccountContext, identity: AccountIdentity): void {
  if (!isAccountContextCurrent(ctx, identity)) throw new StaleAccountContext();
}
