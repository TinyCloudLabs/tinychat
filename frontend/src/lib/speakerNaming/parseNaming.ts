// Reading the model's answers about who a note's speakers are, as pure functions.
//
// The model reads the transcript NAMING_READINGS times, because it does not give the same answer every time. A
// name is kept only when its evidence is really in the transcript and NAMING_AGREE readings give it. An answer can
// produce nothing but names: cleaned like a typed name (`cleanSpeakerName`), backed by a quote the transcript
// contains, for labels the note has.
import { cleanSpeakerName } from "@/capture/library/speakerNames";
import { isPersonName } from "@/lib/meetingTitle";

import { flatText, type NamingPrompt } from "./namingPrompt";

export const NAMING_READINGS = 3;
export const NAMING_AGREE = 2;

/** How the transcript supports a name. Anything else the model writes counts as "inferred". */
export const NAMING_BASES = ["self-introduction", "introduced", "thanked", "inferred"] as const;
/**
 * The basis of a name the app took from the note's calendar link (inviteeSuggestion.ts): the person was invited,
 * which says nothing of what the transcript holds. Not one of NAMING_BASES: a model's reply, or a stored run, that
 * writes it is read as "inferred".
 */
export const INVITED_BASIS = "invited";
export type NamingBasis = (typeof NAMING_BASES)[number] | typeof INVITED_BASIS;

export interface SuggestedName {
  name: string;
  basis: NamingBasis;
  /** The words of the transcript that show it, as the model copied them. Empty for an invited name. */
  quote: string;
}

export type NamingOutcome =
  /** Stored label -> suggestion; a label without agreement is absent. May be empty. */
  | { ok: true; names: Record<string, SuggestedName> }
  /** Fewer than NAMING_AGREE readings could be used. */
  | { ok: false };

const MAX_QUOTE_LENGTH = 300;

interface ReadSpeaker { speaker: string; name: string; basis: NamingBasis; quote: string }

/**
 * One answer: the JSON between the first `{` and the last `}`, as the speakers it names with a quote. Null when it is
 * anything else (no opinion). A speaker with no name, or no quote, is left out.
 */
export function parseReading(reply: string): ReadSpeaker[] | null {
  let answer: unknown;
  try { answer = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)); } catch { return null; }
  const speakers = (answer as { speakers?: unknown } | null)?.speakers;
  if (!Array.isArray(speakers)) return null;
  return speakers.flatMap((entry: { speaker?: unknown; name?: unknown; basis?: unknown; quote?: unknown } | null) => {
    if (typeof entry?.speaker !== "string" || typeof entry.name !== "string" || typeof entry.quote !== "string") return [];
    if (entry.name === "" || entry.name === "null") return [];
    const basis = NAMING_BASES.find((known) => known === entry.basis) ?? "inferred";
    return [{ speaker: entry.speaker, name: entry.name, basis, quote: entry.quote }];
  });
}

/** Edit distance, for names the transcript spells its own way ("Varella" for Varela). */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), row[j]! + 1, next[j - 1]! + 1);
    row = next;
  }
  return row[b.length]!;
}

const bare = (name: string): string => flatText(name).replace(/^(sir|dr|professor|prof) /, "");

/**
 * The candidate a guessed name means, in the candidate's spelling: the same name bar a title or two letters, or a
 * lone first or last name that only one candidate has (one letter off allowed). Otherwise the name as guessed.
 */
export function candidateFor(name: string, candidates: readonly string[]): string {
  const guess = bare(name);
  const close = candidates.filter((candidate) => distance(bare(candidate), guess) <= 2);
  if (close.length === 1) return close[0]!;
  if (guess.includes(" ")) return name;
  const part = candidates.filter((candidate) => bare(candidate).split(" ").some((word) => distance(word, guess) <= 1));
  return part.length === 1 ? part[0]! : name;
}

/**
 * The names the readings agree on, for the labels in `eligible` (stored labels). `replies` holds one model reply per
 * reading that came back. A name stands in a reading only if its quote occurs in the transcript; a quote the model
 * made up drops it.
 */
export function agreeOnNames(replies: readonly string[], prompt: NamingPrompt, candidates: readonly string[],
  eligible: ReadonlySet<string>): NamingOutcome {
  const readings = replies.flatMap((reply) => { const reading = parseReading(reply); return reading === null ? [] : [reading]; });
  if (readings.length < NAMING_AGREE) return { ok: false };
  const names: Record<string, SuggestedName> = {};
  for (const [speaker, label] of prompt.labels) {
    if (!eligible.has(label)) continue;
    const votes = new Map<string, { count: number; suggestion: SuggestedName }>();
    for (const reading of readings) {
      const read = reading.find((entry) => entry.speaker === speaker);
      if (!read) continue;
      const quote = flatText(read.quote);
      if (quote === "" || !prompt.transcript.includes(quote)) continue;
      const name = cleanSpeakerName(candidateFor(read.name, candidates));
      if (!isPersonName(name)) continue;
      const key = flatText(name);
      const seen = votes.get(key);
      if (seen) seen.count++;
      else votes.set(key, { count: 1, suggestion: { name, basis: read.basis, quote: read.quote.replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE_LENGTH) } });
    }
    const top = [...votes.values()].sort((a, b) => b.count - a.count)[0];
    if (top && top.count >= NAMING_AGREE) names[label] = top.suggestion;
  }
  return { ok: true, names };
}
