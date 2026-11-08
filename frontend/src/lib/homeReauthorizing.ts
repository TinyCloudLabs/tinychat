// Whether a Home permission ask is re-authorising (OpenKey may be open). New recordings and uploads wait for it to end,
// so the session swap that follows a grant never cuts one off.
let reauthorizing = false;
const listeners = new Set<() => void>();

export function setHomeReauthorizing(value: boolean): void {
  reauthorizing = value;
  for (const listener of [...listeners]) listener();
}

export function isHomeReauthorizing(): boolean {
  return reauthorizing;
}

export function subscribeHomeReauthorizing(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
