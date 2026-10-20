// TC-1152 S2c-1: which Library rows can be combined with an open meeting.
//
// Only meeting captures with a recorded start AND length qualify: voice notes and uploads have no
// trustworthy clock (the stitcher treats their time window as untrusted), `exo-merged` rows are never
// members, and a standalone Gemini-notes row (a summary document with no duration) falls out because
// it has no length. A pair is offered only when its recorded windows, each padded by the stitcher's
// own tolerance, overlap: the same rule as the stitcher's time window, so the picker never offers a
// pair the stitcher would refuse for time alone.
import { EXO_MERGED_SOURCE, STITCH_TIME_PAD_S } from "@tinyboilerplate/core";

import { libraryKind } from "../libraryKinds";
import type { LibraryItem } from "../LibraryRow";

interface Window { startS: number; endS: number }

function windowOf(item: LibraryItem): Window | null {
  if (item.onPhone || item.source === EXO_MERGED_SOURCE || libraryKind(item.source) !== "meeting") return null;
  const start = Date.parse(item.startedAt ?? "");
  if (!Number.isFinite(start) || item.durationSecs === null || !(item.durationSecs > 0)) return null;
  return { startS: start / 1000, endS: start / 1000 + item.durationSecs };
}

/** Seconds between two recorded windows; 0 or less when they overlap. */
export function windowGapS(a: LibraryItem, b: LibraryItem): number | null {
  const wa = windowOf(a);
  const wb = windowOf(b);
  return wa && wb ? Math.max(wb.startS - wa.endS, wa.startS - wb.endS) : null;
}

/** The open meeting can start a combine (it is a meeting capture with a recorded time and length). */
export function canCombine(item: LibraryItem): boolean {
  return windowOf(item) !== null;
}

/** Other captures that overlap `source` in time, nearest start first. */
export function combineCandidates(source: LibraryItem, items: readonly LibraryItem[]): LibraryItem[] {
  if (windowOf(source) === null) return [];
  return items
    .filter((other) => other.id !== source.id && !(other.source === source.source && other.sourceId === source.sourceId))
    .filter((other) => {
      const gap = windowGapS(source, other);
      return gap !== null && gap <= STITCH_TIME_PAD_S;
    })
    .sort((x, y) => Math.abs(Date.parse(x.startedAt!) - Date.parse(source.startedAt!)) - Math.abs(Date.parse(y.startedAt!) - Date.parse(source.startedAt!)));
}
