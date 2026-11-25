// What a naming run leaves on a voice note, and what of it the note shows, as pure functions.
//
// Stored in the note row's metadata (`connector_meeting.metadata`) beside `speaker_names`, and never applied on its
// own: a suggestion becomes a name only when the user accepts it, which is a rename like any other.
//   "speaker_name_suggestions": {
//     "hash": "<the transcript revision the readings were made from>", "model": "moonshotai/kimi-k3.1-pro",
//     "at": "<ISO time>",
//     "names": { "Speaker 2": { "name": "Alice Chen", "basis": "introduced", "quote": "Here's Alice Chen from …" } },
//     "dismissed": ["Speaker 3"] }
// Not `speaker_suggestions` (speakerNames.ts): those are names the app took from the call window and already
// wrote to `speaker_names`, marked "Suggested". The two keys are kept apart and are never merged.
import { cleanSpeakerName, type SpeakerNames } from "@/capture/library/speakerNames";

import { NAMING_BASES, type SuggestedName } from "./parseNaming";

export const NAME_SUGGESTIONS_KEY = "speaker_name_suggestions";
/**
 * Where the metadata a note page reads carries the hash of the transcript revision the note shows
 * (`voice_note_transcript.hash`). The Library lays it over the row's metadata when it reads; it is never stored.
 */
export const TRANSCRIPT_HASH_KEY = "transcript_hash";
/** The engines whose transcripts are named. Never the on-device engine: its promise is that nothing leaves the device. */
export const NAMED_ENGINES: ReadonlySet<unknown> = new Set(["private-cloud", "assemblyai"]);

export interface NameSuggestions {
  hash: string;
  model: string;
  at: string;
  /** Stored label -> the name suggested for it. Empty when a run found none. */
  names: Readonly<Record<string, SuggestedName>>;
  /** Stored labels whose suggestion the user dismissed. */
  dismissed: readonly string[];
}

export type ShownNameSuggestions = Readonly<Record<string, SuggestedName>>;
export const NO_NAME_SUGGESTIONS: ShownNameSuggestions = Object.freeze({});

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Whether names can be suggested for a voice note, going by the metadata its page reads: a committed transcript
 * (it has a revision to store the suggestions against) made by one of the NAMED_ENGINES, and not one the user pasted.
 */
export function canSuggestNames(metadata: unknown): boolean {
  const note = record(metadata);
  return note !== null && note.capture !== "pasted" && note.transcription_outcome === "transcribed"
    && NAMED_ENGINES.has(note.transcription_engine) && typeof note[TRANSCRIPT_HASH_KEY] === "string";
}

/** The row metadata's suggestions; null when there are none or the value is not the shape a run writes. */
export function readNameSuggestions(metadata: unknown): NameSuggestions | null {
  const stored = record(record(metadata)?.[NAME_SUGGESTIONS_KEY]);
  if (stored === null || typeof stored.hash !== "string" || stored.hash === "") return null;
  const names = Object.entries(record(stored.names) ?? {}).flatMap(([label, value]) => {
    const entry = record(value);
    const name = typeof entry?.name === "string" ? cleanSpeakerName(entry.name) : "";
    if (name === "" || name === label) return [];
    const basis = NAMING_BASES.find((known) => known === entry?.basis) ?? "inferred";
    return [[label, { name, basis, quote: typeof entry?.quote === "string" ? entry.quote : "" }] as const];
  });
  return {
    hash: stored.hash,
    model: typeof stored.model === "string" ? stored.model : "",
    at: typeof stored.at === "string" ? stored.at : "",
    names: Object.fromEntries(names),
    dismissed: Array.isArray(stored.dismissed) ? stored.dismissed.filter((label): label is string => typeof label === "string") : [],
  };
}

/**
 * The suggestions of the transcript the note shows, or null when it has none: nothing stored, or what is stored was
 * made from another revision of the transcript (stale; a new run replaces it).
 */
export function currentNameSuggestions(metadata: unknown): NameSuggestions | null {
  const stored = readNameSuggestions(metadata);
  return stored !== null && stored.hash === record(metadata)?.[TRANSCRIPT_HASH_KEY] ? stored : null;
}

/**
 * The suggestions a note shows: those of its current transcript, without the dismissed ones and without the labels
 * the user has named (`overrides`, the note's `speaker_names`).
 */
export function shownNameSuggestions(metadata: unknown, overrides: SpeakerNames, dismissed: ReadonlySet<string> = new Set()): ShownNameSuggestions {
  const current = currentNameSuggestions(metadata);
  if (current === null) return NO_NAME_SUGGESTIONS;
  const shown = Object.entries(current.names).filter(([label]) =>
    !Object.hasOwn(overrides, label) && !current.dismissed.includes(label) && !dismissed.has(label));
  return shown.length === 0 ? NO_NAME_SUGGESTIONS : Object.freeze(Object.fromEntries(shown));
}
