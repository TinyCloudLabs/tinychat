// The framed apps holding grants right now, so sign-out can revoke them while One's session still can.
// Kept tiny and free of the SDK: App imports it into the entry chunk.

const closers = new Set<() => Promise<void>>();

/** Registers a framed app's close (revoke + tell the child); returns the unregister. */
export function trackEmbed(close: () => Promise<void>): () => void {
  closers.add(close);
  return () => closers.delete(close);
}

/** Revokes every framed app's grants, waiting at most `timeoutMs` so sign-out never hangs on the network. */
export async function closeAllEmbeds(timeoutMs = 3000): Promise<void> {
  if (closers.size === 0) return;
  const all = Promise.allSettled([...closers].map((close) => close()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
}
