// The framed apps open right now, so sign-out can tell each child to drop its key.
// Kept tiny and free of the SDK: App imports it into the entry chunk.

const closers = new Set<() => Promise<void>>();

/** Registers a framed app's close (tells the child); returns the unregister. */
export function trackEmbed(close: () => Promise<void>): () => void {
  closers.add(close);
  return () => closers.delete(close);
}

/** Closes every framed app, waiting at most `timeoutMs` so sign-out never hangs. */
export async function closeAllEmbeds(timeoutMs = 3000): Promise<void> {
  if (closers.size === 0) return;
  const all = Promise.allSettled([...closers].map((close) => close()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
}
