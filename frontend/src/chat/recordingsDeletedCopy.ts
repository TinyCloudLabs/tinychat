/**
 * TC-3136 owner-facing wording for the "Delete my recordings first" step (Monica, final, no counts).
 *
 * `own` recordings were the account's own and are confirmed deleted at the provider. `shared` were shared
 * with the account by someone else: they are only dropped from this list, and the person who shared them
 * still has them, so they are never reported as deleted. Only call these once every own delete is confirmed.
 */
export const NOTHING_TO_DELETE = "You have no recordings to delete.";
export const NOTHING_OF_YOURS = "You had no recordings of your own to delete.";
/** At least one of the account's own deletes is not confirmed yet: true whether or not some are already done. */
export const STILL_DELETING = "Your recordings are being deleted. We keep trying until each one is gone.";
export const SHARED_REMOVED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";

export const OWN_DELETED = "Your recordings are deleted.";

/** Every own delete is confirmed (one or many: no counts, no singular). */
export function doneText(own: number, shared: number): string {
  if (own === 0 && shared === 0) return NOTHING_TO_DELETE;
  if (own === 0) return `${NOTHING_OF_YOURS} ${SHARED_REMOVED}`;
  return shared > 0 ? `${OWN_DELETED} ${SHARED_REMOVED}` : OWN_DELETED;
}

/** At least one own delete is still pending; shared removals are already final and may be said. */
export function pendingText(shared: number): string {
  return shared > 0 ? `${STILL_DELETING} ${SHARED_REMOVED}` : STILL_DELETING;
}
