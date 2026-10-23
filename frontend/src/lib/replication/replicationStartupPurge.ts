// Lets an ON sign-in/restore wait for any local-copy removal that is still running (the page-load
// purge in replicationOffPurge.ts, or a click-time switch-off/wipe in replicationSwitch.ts), so a
// replica is never built while the origin copy is being deleted. Kept apart from
// replicationOffPurge.ts (which imports replicationClient.ts) so the client can import it
// without a cycle. Resolves at once when nothing is in flight.
const inFlight = new Set<Promise<unknown>>();

export function trackStartupPurge<T>(purge: Promise<T>): Promise<T> {
  inFlight.add(purge);
  const done = () => { inFlight.delete(purge); };
  purge.then(done, done);
  return purge;
}

/** Waits until nothing tracked is running, including removals started while waiting. Never rejects. */
export async function startupPurgeSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
