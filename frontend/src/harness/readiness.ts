/** Maximum time to wait for a screen's readyWhen element before reporting a miss. */
export const READY_CAP_MS = 5_000;

/**
 * Resolves true once `isReady()` holds; resolves false if cancelled or if `capMs` expires.
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
): Promise<boolean> {
  const until = performance.now() + capMs;
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (isCancelled()) resolve(false);
      else if (isReady()) resolve(true);
      else if (performance.now() > until) resolve(false);
      else setTimeout(check, pollMs);
    };
    check();
  });
}
