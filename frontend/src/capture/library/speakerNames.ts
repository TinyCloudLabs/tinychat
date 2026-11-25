// A note's speaker names (TC-2189): a display override kept beside the note, keyed by the label the
// transcript was stored with. The stored sentences are never rewritten. A new transcript of the same
// recording keeps the names of the two sides of a call; a numbered speaker's name stays only while the
// engine and the set of labels stay the same (speakerNamesAfterNewTranscript).
//
// Stored in the note row's metadata (`connector_meeting.metadata`):
//   "speaker_names": { "Me": "Sam", "Them": "Alice, Bob" }
//
// A name the app suggested (names in the call, see callParticipants.ts) is written to `speaker_names`
// like any other, and `speaker_suggestions` records that it was a suggestion:
//   "speaker_suggestions": { "Them": { "name": "Alice", "source": "call_window", ... } }
// The label shows as suggested exactly while its suggested name is the name shown. Who spoke when adds one per
// "Them N" label (reason "speaking_marker"), and `speaker_suggestions_made` records each label the app has made (or
// skipped) its suggestion for, so an ended suggestion is never made again.

import { OTHER_SIDE_LABELS, OWN_SIDE_LABELS } from "./speakerNamesCopy";

export const SPEAKER_NAMES_KEY = "speaker_names";
export const SPEAKER_SUGGESTIONS_KEY = "speaker_suggestions";
export const SPEAKER_SUGGESTIONS_MADE_KEY = "speaker_suggestions_made";
export const MAX_SPEAKER_NAME_LENGTH = 80;
/** Names a new transcript took off numbered speakers, oldest first: a list of strings beside `speaker_names`. */
export const EARLIER_SPEAKER_NAMES_KEY = "earlier_speaker_names";

/** Original label -> name shown. Only differing, non-empty names are kept. */
export type SpeakerNames = Readonly<Record<string, string>>;

export const NO_SPEAKER_NAMES: SpeakerNames = Object.freeze({});

/** One `speaker_suggestions` entry: the name suggested for a label, and how it was found. */
export interface SpeakerSuggestion {
  name: string;
  source: "call_window";
  confidence: "high";
  /** One other person in the call (for "Them"), or their speaking marker was on while each line was said ("Them N"). */
  reason: "one_other_participant" | "speaking_marker";
  /** The `call_participants` person the name is from. */
  person: string;
  /** When it was suggested (ISO time). */
  at: string;
}

/** Original label -> the name suggested for it. */
export type SuggestedSpeakerNames = Readonly<Record<string, string>>;

export const NO_SUGGESTED_SPEAKER_NAMES: SuggestedSpeakerNames = Object.freeze({});

/** Spaces collapsed, and at most `MAX_SPEAKER_NAME_LENGTH` characters: cut by code point, so no character is split in half. */
export function cleanSpeakerName(value: string): string {
  return [...value.replaceAll(/\s+/g, " ").trim()].slice(0, MAX_SPEAKER_NAME_LENGTH).join("").trim();
}

/** The row metadata's overrides; anything not a string-to-string object is ignored. */
export function readSpeakerNames(metadata: unknown): SpeakerNames {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return NO_SPEAKER_NAMES;
  const raw = (metadata as Record<string, unknown>)[SPEAKER_NAMES_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return NO_SPEAKER_NAMES;
  const entries = Object.entries(raw).flatMap(([original, name]) => {
    const shown = typeof name === "string" ? cleanSpeakerName(name) : "";
    return shown === "" || shown === original ? [] : [[original, shown] as const];
  });
  return entries.length === 0 ? NO_SPEAKER_NAMES : Object.freeze(Object.fromEntries(entries));
}

/** The suggested names in the row metadata; an entry without a usable name is ignored. */
export function readSuggestedSpeakerNames(metadata: unknown): SuggestedSpeakerNames {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return NO_SUGGESTED_SPEAKER_NAMES;
  const raw = (metadata as Record<string, unknown>)[SPEAKER_SUGGESTIONS_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return NO_SUGGESTED_SPEAKER_NAMES;
  const entries = Object.entries(raw).flatMap(([original, entry]) => {
    const name = entry !== null && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
      ? cleanSpeakerName((entry as { name: string }).name) : "";
    return name === "" ? [] : [[original, name] as const];
  });
  return entries.length === 0 ? NO_SUGGESTED_SPEAKER_NAMES : Object.freeze(Object.fromEntries(entries));
}

/** `suggestions` without the one for `original`: what any name written for that label leaves (patchRowSpeakerName). */
export function withoutSuggestedSpeakerName(suggestions: SuggestedSpeakerNames, original: string): SuggestedSpeakerNames {
  if (!Object.hasOwn(suggestions, original)) return suggestions;
  const rest = Object.entries(suggestions).filter(([key]) => key !== original);
  return rest.length === 0 ? NO_SUGGESTED_SPEAKER_NAMES : Object.freeze(Object.fromEntries(rest));
}

/** The labels shown as suggested: those whose suggested name is the name they show. A rename to anything else ends it. */
export function suggestedSpeakers(names: SpeakerNames, suggestions: SuggestedSpeakerNames): ReadonlySet<string> {
  return new Set(Object.keys(suggestions).filter((original) => Object.hasOwn(names, original) && names[original] === suggestions[original]));
}

/** `names` with `original` shown as `shown`; an empty name, or the original label itself, clears the override. */
export function withSpeakerName(names: SpeakerNames, original: string, shown: string): SpeakerNames {
  const next = Object.entries(names).filter(([key]) => key !== original);
  const name = cleanSpeakerName(shown);
  if (name !== "" && name !== original) next.push([original, name]);
  return next.length === 0 ? NO_SPEAKER_NAMES : Object.freeze(Object.fromEntries(next));
}

export function speakerDisplayName(names: SpeakerNames, original: string): string;
export function speakerDisplayName(names: SpeakerNames, original: string | null): string | null;
export function speakerDisplayName(names: SpeakerNames, original: string | null): string | null {
  if (original === null) return null;
  return Object.hasOwn(names, original) ? names[original]! : original;
}

/** Sentences (or gaps) with their speakers shown by name, for copy and export. */
export function applySpeakerNames<T extends { speaker_name: string | null }>(items: readonly T[], names: SpeakerNames): T[] {
  if (Object.keys(names).length === 0) return [...items];
  return items.map((item) => item.speaker_name !== null && Object.hasOwn(names, item.speaker_name)
    ? { ...item, speaker_name: names[item.speaker_name]! } : item);
}

/** What made a transcript and the speaker labels it uses. */
export interface TranscriptLabels { engine: string | null; labels: readonly string[] }

/**
 * What a new transcript does to a note's names: a JSON merge patch for the row's metadata, or null when they all
 * stay. The two sides of a call ("Me", "Them") are the same people whatever engine listened, so their names stay.
 * A numbered speaker is not: "Speaker 2" from another engine, or among a different set of speakers, can be someone
 * else. When the engine or the set of labels changed, every other label's name comes off and is kept under
 * `earlier_speaker_names`, so that it is not lost and can be offered again.
 */
export function speakerNamesAfterNewTranscript(metadata: unknown, before: TranscriptLabels, after: TranscriptLabels): Record<string, unknown> | null {
  const was = new Set(before.labels);
  const now = new Set(after.labels);
  if (before.engine === after.engine && was.size === now.size && [...was].every((label) => now.has(label))) return null;
  const names = readSpeakerNames(metadata);
  const removed = Object.keys(names).filter((label) => !OWN_SIDE_LABELS.has(label) && !OTHER_SIDE_LABELS.has(label));
  if (removed.length === 0) return null;
  const stored = (metadata as Record<string, unknown>)[EARLIER_SPEAKER_NAMES_KEY];
  const earlier = Array.isArray(stored) ? stored.filter((name): name is string => typeof name === "string") : [];
  const seen = new Set<string>();
  const kept = [...earlier, ...removed.map((label) => names[label]!)].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { [SPEAKER_NAMES_KEY]: Object.fromEntries(removed.map((label) => [label, null])), [EARLIER_SPEAKER_NAMES_KEY]: kept };
}
