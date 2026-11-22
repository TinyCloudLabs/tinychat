/** How long a page that has come back waits before it sends again, so the connection is up. */
export const RETURN_RETRY_MS = 500;

/**
 * One answer write. A phone that switches apps while the write is in flight drops its connection, so the write fails
 * though nothing is wrong with the answer. When the write fails after the page was hidden and the answer is still held
 * in the outbox, it is sent once more as soon as the page is visible again: the same write, the same response ID, so
 * it cannot land twice. Any other failure, and a failure of the second write, is the caller's as before.
 *
 * `stillHeld` is false for an answer the node refused, which is not sent again.
 */
export async function retryAfterHide<T>(attempt: () => Promise<T>, stillHeld: () => boolean, delayMs = RETURN_RETRY_MS): Promise<T> {
  let wasHidden = document.visibilityState === "hidden";
  // Any change of visibility means the page was hidden: a phone may freeze the page before the "hidden" one is seen.
  const onChange = () => { wasHidden = true; };
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("pagehide", onChange);
  let failure: unknown;
  try { return await attempt(); }
  catch (error) { failure = error; }
  finally {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("pagehide", onChange);
  }
  if (!wasHidden || !stillHeld()) throw failure;
  // Executor form on purpose: Promise.withResolvers is missing from older phone browsers and from the build's lib.
  if (document.visibilityState === "hidden") {
    await new Promise<void>((resolve) => {
      const onVisible = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onVisible);
        resolve();
      };
      document.addEventListener("visibilitychange", onVisible);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (!stillHeld()) throw failure;
  return attempt();
}
