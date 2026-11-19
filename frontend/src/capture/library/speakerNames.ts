// A note's speaker names (TC-2189): a display override kept beside the note, keyed by the label the
// transcript was stored with. The stored sentences are never rewritten, so a new transcript of the
// same recording still carries the original labels and the same override applies to it.
//
// Stored in the note row's metadata (`connector_meeting.metadata`):
//   "speaker_names": { "Me": "Sam", "Them": "Alice, Bob" }
//
// A name the app suggested (names in the call, see callParticipants.ts) is written to `speaker_names`
// like any other, and `speaker_suggestions` records that it was a suggestion:
//   "speaker_suggestions": { "Them": { "name": "Alice", "source": "call_window", ... } }
// The label shows as suggested exactly while its suggested name is the name shown.

export const SPEAKER_NAMES_KEY = "speaker_names";
export const SPEAKER_SUGGESTIONS_KEY = "speaker_suggestions";
export const MAX_SPEAKER_NAME_LENGTH = 80;

/** Original label -> name shown. Only differing, non-empty names are kept. */
export type SpeakerNames = Readonly<Record<string, string>>;

export const NO_SPEAKER_NAMES: SpeakerNames = Object.freeze({});

/** One `speaker_suggestions` entry: the name suggested for a label, and how it was found. */
export interface SpeakerSuggestion {
  name: string;
  source: "call_window";
  confidence: "high";
  reason: "one_other_participant";
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
