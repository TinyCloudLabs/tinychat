// TC-1152 S2c-1: fake captures for the Combine screens. Invented text and names only; no user data.
// Two partial captures of one meeting (Fireflies has the first 30 minutes, the Notetaker the last 35, from
// ten minutes in; the stitcher finds the overlap from the words), a third capture in the same window that is a
// different meeting, and a combined meeting built from the pair by the real stitcher.
import { stitchMeetings, type MeetingSnapshot } from "@tinyboilerplate/core";

import { combineSpace, type CombineSpace, type SpaceRow } from "./combineSpace";

const at = (hour: number, minute: number) => new Date(2026, 9, 5, hour, minute).toISOString();

const NUMBER = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const SUBJECT = ["the beta", "the Library", "the release notes", "the iOS build", "the pricing page", "the onboarding flow", "the sync job", "the search index"];
const VERB = ["ship", "review", "demo", "freeze", "retest", "document", "split"];
const WHEN = ["on Monday", "before Friday", "this sprint", "after lunch", "next week", "by the end of the month"];

/** Sentence i of a meeting: distinct words per i, so the stitcher sees many one-off phrases. */
function sentence(flavour: string, i: number): string {
  const n = `${NUMBER[i % 20]}${i >= 20 ? ` of ${NUMBER[Math.floor(i / 20)]}` : ""}`;
  return `${flavour} point ${n}: we agreed ${SUBJECT[(i * 3) % 8]} should ${VERB[(i * 5) % 7]} ${WHEN[(i * 7) % 6]}, as ${SUBJECT[(i * 5 + 1) % 8]} depends on it.`;
}

/** `count` segments, one every 30 s, numbered from `from` (so two captures can share the middle of a meeting). */
function body(flavour: string, from: number, count: number, speaker: (i: number) => string): string {
  return JSON.stringify(Array.from({ length: count }, (_, k) => ({
    index: k, speaker_name: speaker(from + k), text: sentence(flavour, from + k), start_time: k * 30, end_time: k * 30 + 28,
  })));
}

const NAMES = ["Ana", "Ben", "Mira"];
export const FIREFLIES_WEEKLY: SpaceRow = {
  id: "ff-weekly", source: "fireflies", sourceId: "ff-weekly", title: "Weekly planning", startedAt: at(14, 0), durationSecs: 1800,
  participants: JSON.stringify(NAMES.map((name) => ({ name, email: null }))), metadata: "{}", body: body("Planning", 0, 60, (i) => NAMES[i % 3]!),
};
export const NOTETAKER_WEEKLY: SpaceRow = {
  id: "nt-weekly", source: "tinycloud-transcriber", sourceId: "mtg_weekly", title: "Weekly planning (notetaker)", startedAt: at(14, 10), durationSecs: 2100,
  participants: JSON.stringify([{ name: "Ana", email: null }, { name: "Ben", email: null }]), metadata: "{}", body: body("Planning", 20, 70, (i) => `speaker_${i % 3}`),
};
/** In the same window, different words: the check refuses this pair. */
export const FIREFLIES_DESIGN: SpaceRow = {
  id: "ff-design", source: "fireflies", sourceId: "ff-design", title: "Design review", startedAt: at(14, 20), durationSecs: 2400,
  participants: JSON.stringify([{ name: "Mira", email: null }, { name: "Lee", email: null }]), metadata: "{}", body: body("Design", 0, 60, (i) => (i % 2 ? "Mira" : "Lee")),
};
/** Not offered by the picker: a day later. */
export const FIREFLIES_LATER: SpaceRow = {
  id: "ff-later", source: "fireflies", sourceId: "ff-later", title: "Retro", startedAt: new Date(2026, 9, 6, 9, 0).toISOString(), durationSecs: 1800, metadata: "{}", body: body("Retro", 0, 30, () => "Ana"),
};

export const COMBINE_ROWS: SpaceRow[] = [FIREFLIES_WEEKLY, NOTETAKER_WEEKLY, FIREFLIES_DESIGN, FIREFLIES_LATER];

const snapshot = (row: SpaceRow): MeetingSnapshot => ({
  source: row.source, source_id: row.sourceId, body: row.body,
  row: { title: row.title, started_at: row.startedAt, duration_secs: row.durationSecs, participants: row.participants, metadata: row.metadata },
});

/** The combined meeting of the Weekly planning pair, as combine would have stored it (row id fixed for the screens). */
export const COMBINED_ROW_ID = "combined-weekly";
export function combinedWeekly(): SpaceRow[] {
  const result = stitchMeetings(snapshot(FIREFLIES_WEEKLY), snapshot(NOTETAKER_WEEKLY));
  if (result.combined === null) throw new Error("harness: the Weekly planning pair must pass the check");
  const { row, body: stitched } = result.combined;
  return [{
    id: COMBINED_ROW_ID, source: row.source, sourceId: row.source_id, title: row.title, startedAt: row.started_at, durationSecs: row.duration_secs,
    participants: JSON.stringify(row.participants),
    metadata: JSON.stringify({ ...row.metadata, merge: { ...row.metadata.merge, decided_at: new Date(2026, 9, 6, 9, 30).toISOString() } }),
    body: JSON.stringify(stitched),
  }];
}

/** A fresh stateful space for one screen. */
export function combineScreenSpace(options: { combined?: boolean; rows?: readonly SpaceRow[] } = {}): CombineSpace {
  return combineSpace([...(options.rows ?? COMBINE_ROWS), ...(options.combined ? combinedWeekly() : [])], { did: "did:test:combine-screens" });
}
