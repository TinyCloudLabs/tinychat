/**
 * TC-3136 owner-facing wording for the "Delete my recordings first" step (Monica, final, no counts).
 *
 * `own` recordings were the account's own and are confirmed deleted at the provider. `shared` were shared
 * with the account by someone else: they are only dropped from this list, and the person who shared them
 * still has them, so they are never reported as deleted. `notDeleted` were listed as the account's own but
 * the provider does not attribute them to it: dropped from the list, NOT deleted at the provider, and never
 * called deleted or shared. Only call `own` deleted once every own delete is confirmed.
 */
export interface Removals {
  own: number;
  shared: number;
  notDeleted: number;
}

export const NOTHING_TO_DELETE = "You have no meeting recordings to delete.";
export const NOTHING_OF_YOURS = "You had no meeting recordings of your own to delete.";
/** At least one of the account's own deletes is not confirmed yet: true whether or not some are already done. */
export const STILL_DELETING = "Your meeting recordings are being deleted. We keep trying until each one is gone.";
export const SHARED_REMOVED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";
/** Own entries the provider does not attribute to the account: dropped from the list, copy NOT deleted. */
export const NOT_DELETED = "Some recordings were removed from your list but are still with the notetaker service. To have them deleted, email team@tinycloud.xyz.";
/** The same case on a single recording's own row after Remove (Monica): no subject needed. */
export const ROW_NOT_DELETED = "Removed from your list but still with the notetaker service. To have it deleted, email team@tinycloud.xyz.";

export const OWN_DELETED = "Your meeting recordings are deleted, including the notetaker service's copies.";

const join = (...parts: Array<string | false>): string => parts.filter((part) => part !== false).join(" ");

/** Every own delete is confirmed (one or many: no counts, no singular). */
export function doneText({ own, shared, notDeleted }: Removals): string {
  if (own === 0 && shared === 0 && notDeleted === 0) return NOTHING_TO_DELETE;
  return join(
    own > 0 ? OWN_DELETED : notDeleted === 0 && NOTHING_OF_YOURS,
    notDeleted > 0 && NOT_DELETED,
    shared > 0 && SHARED_REMOVED,
  );
}

/** At least one own delete is still pending; the removals that are already final may be said. */
export function pendingText({ shared, notDeleted }: Pick<Removals, "shared" | "notDeleted">): string {
  return join(STILL_DELETING, notDeleted > 0 && NOT_DELETED, shared > 0 && SHARED_REMOVED);
}
