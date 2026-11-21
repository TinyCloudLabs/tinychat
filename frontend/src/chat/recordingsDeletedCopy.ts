/**
 * TC-3136 approved owner-facing wording for the "Delete my recordings first" step.
 *
 * `own` recordings were the account's own and are confirmed deleted at the provider. `shared` were shared
 * with the account by someone else: they are only dropped from this list, and the person who shared them
 * still has them, so they are never reported as deleted. `notDeleted` were listed as the account's own but
 * the provider does not attribute them to it: dropped from the list, NOT deleted at the provider, and never
 * called deleted or shared. Only call `own` deleted once every own delete is confirmed. `voiceNotes` counts the
 * private cloud transcription jobs (voice notes and uploads, TC-3166) deleted and read back gone, and is `null`
 * when the deployment does not use that service: then nothing is said about voice notes or uploads, and the
 * earlier meeting-only lines (also Monica's) apply. The step only reaches `done` or `deleting` after the check
 * succeeded, since a failed check is the failure line.
 */
export interface Removals {
  own: number;
  shared: number;
  notDeleted: number;
  voiceNotes: number | null;
}

export const NOTHING_TO_DELETE = "You have no recordings, voice notes or uploads to delete.";
export const NOTHING_OF_YOURS = "You had no recordings, voice notes or uploads of your own to delete.";
/** At least one meeting recording's delete is not confirmed yet; the voice notes and uploads are already deleted. */
export const STILL_DELETING = "Your voice notes and uploads are deleted. Your meeting recordings are being deleted; we keep trying until each one is gone.";

/** Used when the private cloud service is not part of the deployment (`voiceNotes` is null): meetings only. */
export const MEETINGS_ONLY_NOTHING_TO_DELETE = "You have no meeting recordings to delete.";
export const MEETINGS_ONLY_NOTHING_OF_YOURS = "You had no meeting recordings of your own to delete.";
export const MEETINGS_ONLY_STILL_DELETING = "Your meeting recordings are being deleted. We keep trying until each one is gone.";
export const MEETINGS_ONLY_OWN_DELETED = "Your meeting recordings are deleted, including the notetaker service's copies.";
export const SHARED_REMOVED = "Recordings others shared with you are removed from your list; the people who shared them still have them.";
/** Own entries the provider does not attribute to the account: dropped from the list, copy NOT deleted. */
export const NOT_DELETED = "Some recordings were removed from your list but are still with the notetaker service. To have them deleted, email team@tinycloud.xyz.";
/** The same case on a single recording's own row after Remove. */
export const ROW_NOT_DELETED = "Removed from your list but still with the notetaker service. To have it deleted, email team@tinycloud.xyz.";

export const OWN_DELETED = "Your meeting recordings, voice notes and uploads are deleted from the notetaker service and TinyCloud Private Transcription.";
/** The step's failure line: any unconfirmed delete, meeting recordings or private cloud. */
export const DELETE_FAILED = "We couldn't finish deleting your recordings, voice notes and uploads. Some may still be there. Try again in a moment.";
/** The step's intro. */
export const STEP_INTRO = "Before you delete your account, delete your recordings. This permanently deletes your meeting recordings, voice notes and uploads held by the notetaker service and TinyCloud Private Transcription, including their transcripts.";

/** The step's intro and failure line when the deployment does not use private cloud transcription. */
export const STEP_INTRO_MEETINGS_ONLY = "Before you delete your account, delete your recordings. This permanently deletes your meeting recordings and transcripts, including the notetaker service's copies.";
export const DELETE_FAILED_MEETINGS_ONLY = "We couldn't finish deleting your recordings. Some may still be there. Try again in a moment.";

export const ACCOUNT_PENDING_CONTINUE = "You can continue to delete your account; we keep deleting them after it's gone.";
export const ACCOUNT_FAILED_CONTINUE = "If you continue to delete your account, email team@tinycloud.xyz to have the rest deleted.";

const join = (...parts: Array<string | false>): string => parts.filter((part) => part !== false).join(" ");

/** Every own delete is confirmed (one or many: no counts, no singular). */
export function doneText({ own, shared, notDeleted, voiceNotes }: Removals): string {
  const privateCloud = voiceNotes !== null;
  if (own === 0 && shared === 0 && notDeleted === 0 && (voiceNotes ?? 0) === 0) {
    return privateCloud ? NOTHING_TO_DELETE : MEETINGS_ONLY_NOTHING_TO_DELETE;
  }
  return join(
    own + (voiceNotes ?? 0) > 0
      ? (privateCloud ? OWN_DELETED : MEETINGS_ONLY_OWN_DELETED)
      : notDeleted === 0 && (privateCloud ? NOTHING_OF_YOURS : MEETINGS_ONLY_NOTHING_OF_YOURS),
    notDeleted > 0 && NOT_DELETED,
    shared > 0 && SHARED_REMOVED,
  );
}

/** At least one own delete is still pending; the removals that are already final may be said. */
export function pendingText({ shared, notDeleted, voiceNotes }: Pick<Removals, "shared" | "notDeleted" | "voiceNotes">): string {
  return join(voiceNotes === null ? MEETINGS_ONLY_STILL_DELETING : STILL_DELETING, notDeleted > 0 && NOT_DELETED, shared > 0 && SHARED_REMOVED);
}
