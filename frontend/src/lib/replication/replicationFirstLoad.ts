// "The app's first data load has settled" (the chat list finished loading, whether it succeeded or
// ended in an error state). The replica fill waits for it so its requests do not compete with the
// app's first reads. Marked from ReplicationFirstLoadSignal (mounted inside the chat runtime);
// re-armed at every sign-in/restore.
let settled = false;
let waiters: Array<() => void> = [];

/** Re-arms the signal for a new sign-in/restore. */
export function resetAppFirstLoad(): void {
  settled = false;
}

export function markAppFirstLoadSettled(): void {
  settled = true;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve();
}

export function appFirstLoadSettled(): Promise<void> {
  if (settled) return Promise.resolve();
  return new Promise<void>((resolve) => { waiters.push(resolve); });
}

/**
 * Folds the two observable load signals into "settled". Settled once the list was seen ACTIVE (its
 * list() loading, or the warm-path revalidate running) and neither is running any more. A fully
 * cached warm list never shows `listLoading` but always runs the revalidate, so it settles too;
 * an idle first render (nothing started yet) does not.
 */
export function createFirstLoadTracker(): (listLoading: boolean, revalidating: boolean) => boolean {
  let active = false;
  return (listLoading, revalidating) => {
    if (listLoading || revalidating) active = true;
    return active && !listLoading && !revalidating;
  };
}
