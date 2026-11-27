// The one name a note's calendar link may suggest for a speaker, as pure functions.
//
// Three things are kept apart: who was invited (`metadata.calendar_link.invitees`), who the call window saw
// (`call_participants`), and who the user says spoke (`speaker_names`). An invitation is the weakest of them:
// people decline, forward the invite, bring someone along or dial in. So an invitee is suggested only for a
// meeting of two, by the rule of `inviteeSuggestion`, and only as a question the user answers with Use or Dismiss:
// nothing here writes a name. The user's own side ("Me") is never the label, and the user's own entry never the name.
//
// A dismissed suggestion is remembered on the row under a key of its own, for the event it was about:
//   "invitee_suggestion_dismissed": { "event_id": "<the linked event>", "labels": ["Speaker 1"] }
// It counts only while the note is linked to that event: linked to another one, the question may be asked again.
import { calendarLinkState, type CalendarLink } from "@tinyboilerplate/core";

import type { CallParticipants } from "@/capture/library/callParticipants";
import { cleanSpeakerName } from "@/capture/library/speakerNames";
import { OWN_SIDE_LABELS } from "@/capture/library/speakerNamesCopy";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { isPersonName } from "@/lib/meetingTitle";

import { suggestibleLabels } from "./namingPrompt";

export const INVITEE_SUGGESTION_DISMISSED_KEY = "invitee_suggestion_dismissed";

export interface InviteeSuggestion {
  /** The stored label of the transcript's one remote voice. */
  label: string;
  /** The display name of the one other person invited. */
  name: string;
}

/**
 * The invitee to suggest for a speaker, or null. All of this has to hold:
 *   - the note is linked to an event whose guest list is whole (`attendees_omitted` is not set) and marks the user
 *     (a `self` invitee), so everyone else is known to be someone else;
 *   - of the other invitees, exactly one did not decline, they accepted, and the calendar gave their name;
 *   - the call window saw nobody (`call` is null): where it did, its own suggestion stands and this one is not made;
 *   - the transcript has exactly one voice that is not the user's: one label other than an own-side label across
 *     all its sentences, and a label a name may be suggested for (`suggestibleLabels`).
 */
export function inviteeSuggestion(link: CalendarLink | null, call: CallParticipants | null,
  sentences: readonly FirefliesSentence[]): InviteeSuggestion | null {
  if (link === null || calendarLinkState(link) !== "linked" || link.attendees_omitted || call !== null) return null;
  if (!link.invitees.some((invitee) => invitee.self)) return null;
  const others = link.invitees.filter((invitee) => !invitee.self && invitee.response !== "declined");
  if (others.length !== 1 || others[0]!.response !== "accepted") return null;
  const name = cleanSpeakerName(others[0]!.name);
  if (!isPersonName(name)) return null;
  const remote = new Set(sentences.flatMap((sentence) =>
    sentence.speaker_name === null || sentence.speaker_name === "" || OWN_SIDE_LABELS.has(sentence.speaker_name) ? [] : [sentence.speaker_name]));
  if (remote.size !== 1) return null;
  const [label] = [...remote] as [string];
  return suggestibleLabels(sentences).has(label) && label !== name ? { label, name } : null;
}

/** The labels whose invitee suggestion the user dismissed while the note was linked to `eventId`; none for another event. */
export function dismissedInviteeLabels(metadata: unknown, eventId: string): string[] {
  const stored = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)[INVITEE_SUGGESTION_DISMISSED_KEY] : null;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return [];
  const { event_id: event, labels } = stored as { event_id?: unknown; labels?: unknown };
  return event === eventId && Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [];
}
