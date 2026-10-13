/** The meeting and voice-note paths share anarlog's one in-process server. */

export interface WhisperServerLease {
  ready: Promise<string>;
  release(): void;
}

type Server = { model: string; ready: Promise<string>; loading: boolean;
  holders: Set<symbol>; stop: () => Promise<void> };
type State = { current: Server | null; closing: Promise<void>; waiters: Set<() => void> };
const scopes = new WeakMap<object, State>();
export const SHARED_WHISPER_SERVER_SCOPE = {};

function signalWaiters(state: State) {
  for (const wake of state.waiters) wake();
  state.waiters.clear();
}

function requestStop(stop: () => Promise<void>): Promise<void> {
  try {
    return stop().catch((error: unknown) => console.warn("Could not stop the local Whisper server", error));
  } catch (error) {
    console.warn("Could not stop the local Whisper server", error);
    return Promise.resolve();
  }
}

export function leaseWhisperServer(model: string, start: () => Promise<string>, stop: () => Promise<void>,
  scope: object = SHARED_WHISPER_SERVER_SCOPE): WhisperServerLease {
  let state = scopes.get(scope);
  if (!state) { state = { current: null, closing: Promise.resolve(), waiters: new Set() }; scopes.set(scope, state); }
  const shared = state;
  const token = Symbol("whisper-server");
  let released = false;
  let server: Server | null = null;
  const ready = (async () => {
    for (;;) {
      await shared.closing;
      if (released) throw new Error("Whisper server lease was released before start");
      if (shared.current && shared.current.model !== model) {
        await new Promise<void>((resolve) => shared.waiters.add(resolve));
        continue;
      }
      if (!shared.current) {
        const created: Server = { model, ready: Promise.resolve(""), loading: true, holders: new Set(), stop };
        created.ready = Promise.resolve().then(start).finally(() => { created.loading = false; });
        shared.current = created;
      }
      server = shared.current;
      server.holders.add(token);
      return server.ready;
    }
  })();
  return {
    ready,
    release() {
      if (released) return;
      released = true;
      if (!server) { signalWaiters(shared); return; }
      server.holders.delete(token);
      if (server.holders.size !== 0 || shared.current !== server) return;
      const departing = server;
      shared.current = null;
      // Signal stop before Record opens its mic. A loading model may finish
      // later; stop again after that late start to release its memory.
      const first = requestStop(departing.stop);
      if (departing.loading) {
        void departing.ready.then(() => {
          if (shared.current === null) return requestStop(departing.stop);
        }, () => undefined);
      }
      shared.closing = first.then(() => { signalWaiters(shared); });
    },
  };
}
