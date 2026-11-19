// Names in the call (phase 1): the people the desktop app read from a meeting's own window (Google Meet,
// Zoom) while it recorded both sides of a call, when the user turned that on. Kept on the note's row as
// evidence, written once, beside the speaker names (speakerNames.ts):
//
//   "call_participants": { "v": 1, "source": "call_window", "app": "google-meet", "truncated": false,
//     "people": [{ "id": "p1", "name": "Robin Sample", "self": true }, { "id": "p2", "name": "Alex Example" }] }
//
// `id` is stable within the recording, in first-seen order; `self` is set only where the meeting app
// marked that entry as the user. The names are offered as choices when a speaker is renamed, and with
// exactly one other person in the call that person is suggested for "Them" (`suggestSpeakerNames`).

import { cleanSpeakerName, MAX_SPEAKER_NAME_LENGTH, type SpeakerSuggestion } from "./speakerNames";
import { OTHER_SIDE_LABELS, OWN_SIDE_LABELS } from "./speakerNamesCopy";

export const CALL_PARTICIPANTS_KEY = "call_participants";
export const MAX_CALL_PARTICIPANTS = 50;
const MAX_PERSON_ID_LENGTH = 32;

/** The label a suggestion names: the other side of a recording of both sides of a call. */
export const SUGGESTED_SPEAKER = "Them";

export type CallApp = "google-meet" | "zoom";
const CALL_APPS: ReadonlySet<string> = new Set<CallApp>(["google-meet", "zoom"]);

export interface CallParticipant {
  id: string;
  name: string;
  self?: true;
}

export interface CallParticipants {
  v: 1;
  source: "call_window";
  app: CallApp;
  people: readonly CallParticipant[];
  /** More people were in the call than are kept. */
  truncated: boolean;
}

const NO_CHOICES: readonly string[] = Object.freeze([]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Control characters, and the invisible ones that reorder or join text on screen (U+200B to U+200F, U+061C, the
 * embedding, override and isolate marks), carry no part of a name someone else chose.
 */
function withoutControls(value: string): string {
  return [...value].filter((char) => {
    const code = char.codePointAt(0)!;
    const control = (code < 0x20 && !/\s/.test(char)) || (code >= 0x7f && code <= 0x9f);
    const invisible = (code >= 0x200b && code <= 0x200f) || code === 0x061c
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    return !control && !invisible;
  }).join("");
}

/**
 * `value` as call participants, or null when it is not that shape or names nobody. Names are cleaned as speaker
 * names are (spaces, 80 characters); an entry with no name or a repeated id is dropped; past 50 people the rest
 * are dropped and `truncated` is set. Used for what the desktop app hands over and for what a row holds.
 */
export function parseCallParticipants(value: unknown): CallParticipants | null {
  if (!isRecord(value) || value.v !== 1 || value.source !== "call_window" || typeof value.app !== "string"
    || !CALL_APPS.has(value.app) || !Array.isArray(value.people)) return null;
  const ids = new Set<string>();
  const people: CallParticipant[] = [];
  let truncated = value.truncated === true;
  for (const entry of value.people as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
    const { id } = entry;
    const name = cleanSpeakerName(withoutControls(entry.name));
    if (id === "" || id.length > MAX_PERSON_ID_LENGTH || name === "" || ids.has(id)) continue;
    if (people.length === MAX_CALL_PARTICIPANTS) {
      truncated = true;
      break;
    }
    ids.add(id);
    people.push(entry.self === true ? { id, name, self: true } : { id, name });
  }
  if (people.length === 0) return null;
  return { v: 1, source: "call_window", app: value.app as CallApp, people, truncated };
}

/** The row metadata's call participants, or null. */
export function readCallParticipants(metadata: unknown): CallParticipants | null {
  return isRecord(metadata) ? parseCallParticipants(metadata[CALL_PARTICIPANTS_KEY]) : null;
}

/** How two names are compared: case and spacing do not make them different. */
const nameKey = (name: string) => cleanSpeakerName(name).toLocaleLowerCase();

/** The entries the meeting app marked as the user. */
const selfPeople = (participants: CallParticipants) => participants.people.filter((person) => person.self);

/**
 * Everyone else, one entry per person: an entry with the name of one the app marked as the user (whatever its case
 * or spacing) is the user. Two people with the same name stay two people.
 */
function otherPeople(participants: CallParticipants): CallParticipant[] {
  const own = new Set(selfPeople(participants).map((person) => nameKey(person.name)));
  return participants.people.filter((person) => !person.self && !own.has(nameKey(person.name)));
}

/** Each name once, in first-seen order and first-seen spelling. */
function distinctNames(people: readonly CallParticipant[]): string[] {
  const seen = new Set<string>();
  return people.map((person) => person.name).filter((name) => {
    const key = nameKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The names to offer when `original` is renamed: the other people for the other side ("Them"), the user's own
 * entry for their side ("Me"), and everyone for any other label. Each name once, in first-seen order.
 */
export function speakerChoices(participants: CallParticipants | null, original: string): readonly string[] {
  if (participants === null) return NO_CHOICES;
  const people = OWN_SIDE_LABELS.has(original) ? selfPeople(participants)
    : OTHER_SIDE_LABELS.has(original) ? otherPeople(participants)
    : participants.people;
  const choices = distinctNames(people).filter((name) => name !== original);
  return choices.length === 0 ? NO_CHOICES : choices;
}

/**
 * The 1:1 rule: when the meeting app marked the user and, without them, exactly one other person was in the call,
 * that person is suggested for "Them". People are counted by id, so two people who share a name are two people.
 * Otherwise nothing is suggested and the names are only offered as choices.
 */
export function suggestSpeakerNames(participants: CallParticipants | null, at: string): Readonly<Record<string, SpeakerSuggestion>> {
  if (participants === null || participants.truncated || selfPeople(participants).length === 0) return {};
  const others = otherPeople(participants);
  if (new Set(others.map((person) => person.id)).size !== 1) return {};
  const [other] = others as [CallParticipant, ...CallParticipant[]];
  return { [SUGGESTED_SPEAKER]: { name: other.name, source: "call_window", confidence: "high",
    reason: "one_other_participant", person: other.id, at } };
}

/** The rename field's text as a list: "Alice ,Bob," reads as "Alice, Bob". */
const asList = (text: string) => text.split(",").map(cleanSpeakerName).filter((name) => name !== "").join(", ");

/** Whether the rename field already lists `name` (a name with commas in it counts as one name). */
export function listsSpeakerName(field: string, name: string): boolean {
  const listed = asList(field).toLocaleLowerCase();
  const wanted = asList(name).toLocaleLowerCase();
  return listed !== "" && wanted !== "" && `, ${listed}, `.includes(`, ${wanted}, `);
}

/**
 * The rename field after a choice is tapped: the name alone in an empty field, otherwise added to the names
 * already there ("Alice" then "Bob" makes "Alice, Bob"). A name already listed, or one that would take the
 * field past the longest name kept, leaves it as it was.
 */
export function withSpeakerChoice(field: string, name: string): string {
  const listed = asList(field);
  const chosen = asList(name);
  if (listed === "") return chosen;
  if (chosen === "" || listsSpeakerName(listed, chosen)) return listed;
  const next = `${listed}, ${chosen}`;
  return [...next].length > MAX_SPEAKER_NAME_LENGTH ? listed : next;
}
