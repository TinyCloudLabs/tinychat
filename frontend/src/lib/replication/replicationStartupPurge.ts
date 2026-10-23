// Lets an ON sign-in/restore wait for the page-load purge (replicationOffPurge.ts) that may still be
// running, so a replica is never built while the origin copy is being deleted. Kept apart from
// replicationOffPurge.ts (which imports replicationClient.ts) so the client can import it
// without a cycle. Resolves at once when no purge was started or it has finished.
let startup: Promise<unknown> | undefined;

export function trackStartupPurge<T>(purge: Promise<T>): Promise<T> {
  startup = purge;
  return purge;
}

/** Never rejects. */
export async function startupPurgeSettled(): Promise<void> {
  try { await startup; } catch { /* the purge reports its own failure */ }
}
