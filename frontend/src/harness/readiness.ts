/** How long a screen may take to show its `readyWhen` element before the capture goes ahead anyway. */
export const READY_CAP_MS = 5_000;

/**
 * Resolves once `isReady()` holds, the caller cancels, or `capMs` has passed.
 * The cap runs on `performance.now()`: `?freeze=1` pins `Date`, so a `Date.now()`
 * cap never expires on a screen that never becomes ready.
 */
export function waitUntilReady(
  isReady: () => boolean,
  {
    capMs = READY_CAP_MS,
    pollMs = 50,
    isCancelled = () => false,
  }: { capMs?: number; pollMs?: number; isCancelled?: () => boolean } = {},
): Promise<void> {
  const until = performance.now() + capMs;
  return new Promise<void>((resolve) => {
    const check = () => {
      if (isCancelled() || isReady() || performance.now() > until) resolve();
      else setTimeout(check, pollMs);
    };
    check();
  });
}
