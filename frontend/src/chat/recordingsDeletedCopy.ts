/**
 * TC-3136 owner-facing wording for the "Delete my recordings first" step (Monica, final).
 *
 * `own` recordings were the account's own and are confirmed deleted at the provider. `shared` were shared
 * with the account by someone else: they are only dropped from this list, and the person who shared them
 * still has them, so they are never reported as deleted.
 */
export function ownDeletedLine(own: number): string {
  return own === 1 ? "Your recording is deleted." : `Your ${own} recordings are deleted.`;
}

export function sharedRemovedLine(shared: number): string {
  return shared === 1
    ? "1 recording shared with you is removed from your list; the person who shared it still has it."
    : `${shared} recordings shared with you are removed from your list; the people who shared them still have them.`;
}

/** Everything was confirmed (no purge still pending). */
export function doneLines(own: number, shared: number): string[] {
  if (own === 0 && shared === 0) return ["You have no recordings to delete."];
  if (own === 0) return ["You had no recordings of your own to delete.", sharedRemovedLine(shared)];
  return shared > 0 ? [ownDeletedLine(own), sharedRemovedLine(shared)] : [ownDeletedLine(own)];
}
