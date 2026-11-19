// TC-1152 S2c-1: the stitcher's detection evidence in plain words, for the confirm sheet.
//
// Pure: the stitcher's verdict, the two Library rows and the two members' stored rows go in; labelled
// lines come out. Nothing here decides anything (the stitcher already did): it only says why.
import type { MeetingSnapshot, StitchResult } from "@tinyboilerplate/core";
import { STITCH_MIN_ANCHORS_PER_MIN, STITCH_MIN_CAPTURE_S, STITCH_SPAN_CAP_S, STITCH_SPAN_FRACTION, STITCH_TIME_PAD_S } from "@tinyboilerplate/core";

import { librarySourceLabel } from "../libraryKinds";
import type { LibraryItem } from "../LibraryRow";
import { windowGapS } from "./candidates";
import { bodySegments, bodySpan } from "./bodySegments";

export interface EvidenceLine {
  id: "phrases" | "spread" | "offset" | "overlap" | "gap" | "participants";
  label: string;
  value: string;
  /** Whether this check, where it is a check, is met. Undefined for facts that are not a test (offset, gap, participants). */
  met?: boolean;
}

export interface CombineEvidence {
  passed: boolean;
  /** "These look like the same meeting" or "These don't look like the same meeting (N matching phrases)". */
  headline: string;
  /** Why a refused pair was refused, in a sentence; null when it passed. */
  reason: string | null;
  lines: EvidenceLine[];
}

/** "47 s", "2 min 5 s", "42 min". */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.round(Math.abs(totalSeconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** Lower-cased distinct names from a stored `participants` column (a JSON string or array of names or `{name}`). */
function participantNames(raw: unknown): Set<string> {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return new Set(); }
  }
  const names = new Set<string>();
  if (!Array.isArray(value)) return names;
  for (const entry of value as unknown[]) {
    const name = typeof entry === "string" ? entry : (entry as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name.trim() !== "") names.add(name.trim().toLowerCase());
  }
  return names;
}

function participantLine(a: MeetingSnapshot, b: MeetingSnapshot): string {
  const na = participantNames(a.row?.participants);
  const nb = participantNames(b.row?.participants);
  if (na.size === 0 || nb.size === 0) return "Participant names aren't recorded on both captures.";
  const shared = [...na].filter((n) => nb.has(n)).length;
  const union = new Set([...na, ...nb]).size;
  return `${shared} of ${union} names appear on both (${Math.round((shared / union) * 100)}%).`;
}

function gapLine(a: LibraryItem, b: LibraryItem): string {
  const startA = Date.parse(a.startedAt ?? "");
  const startB = Date.parse(b.startedAt ?? "");
  const apart = Number.isFinite(startA) && Number.isFinite(startB) ? `Started ${formatSeconds((startA - startB) / 1000)} apart` : "Start times aren't both recorded";
  const gap = windowGapS(a, b);
  if (gap === null) return `${apart}.`;
  return gap <= 0 ? `${apart}; their recorded times overlap.` : `${apart}; ${formatSeconds(gap)} passes between one ending and the other starting.`;
}

/** How much of the shorter capture the other also covers, from each member's place on the aligned timeline. */
function overlapLine(result: StitchResult, a: MeetingSnapshot, b: MeetingSnapshot): string | null {
  if (result.offset_s === null) return null;
  const spans = [a, b].map((snap) => {
    const member = result.members.find((m) => m.source === snap.source && m.source_id === snap.source_id);
    const segments = bodySegments(snap.body);
    const span = segments ? bodySpan(segments) : null;
    return member && span ? { start: member.offset_s + span.first, end: member.offset_s + span.last } : null;
  });
  const [x, y] = spans;
  if (!x || !y) return null;
  const shorter = Math.min(x.end - x.start, y.end - y.start);
  if (!(shorter > 0)) return null;
  const shared = Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return `About ${Math.round(Math.min(1, shared / shorter) * 100)}% of the shorter capture is in both.`;
}

/**
 * The lines the confirm sheet shows. Anchors are the stitcher's "matching phrases": four-word runs
 * that occur once in each capture and agree on one time offset.
 */
export function describeEvidence(result: StitchResult, items: readonly [LibraryItem, LibraryItem], snaps: readonly [MeetingSnapshot, MeetingSnapshot]): CombineEvidence {
  const e = result.evidence;
  const needSpan = Math.min(STITCH_SPAN_CAP_S, STITCH_SPAN_FRACTION * e.shorter_capture_s);
  const lines: EvidenceLine[] = [
    {
      id: "phrases",
      label: "Matching phrases",
      value: `${e.matching_phrases} phrases found once in each capture, at the same moment: ${e.anchors_per_min.toFixed(2)} per minute of the shorter capture. A match needs at least ${STITCH_MIN_ANCHORS_PER_MIN} per minute.`,
      met: e.anchors_per_min >= STITCH_MIN_ANCHORS_PER_MIN,
    },
    {
      id: "spread",
      label: "Spread",
      value: `The matches run across ${formatSeconds(e.span_s)}. A match needs at least ${formatSeconds(needSpan)} (${formatSeconds(STITCH_SPAN_CAP_S)} or ${Math.round(STITCH_SPAN_FRACTION * 100)}% of the shorter capture, whichever is less).`,
      met: e.span_s >= needSpan,
    },
  ];
  if (result.offset_s !== null) {
    lines.push({ id: "offset", label: "Clock difference", value: `Lined up on the meeting's timeline, one capture starts ${formatSeconds(result.offset_s)} after the other. The combined transcript corrects for clock differences.` });
  }
  const overlap = overlapLine(result, snaps[0], snaps[1]);
  if (overlap) lines.push({ id: "overlap", label: "Overlap", value: overlap });
  lines.push({ id: "gap", label: "Time apart", value: gapLine(items[0], items[1]) });
  lines.push({ id: "participants", label: "Participants", value: participantLine(snaps[0], snaps[1]) });

  const passed = result.verdict === "same-meeting";
  let reason: string | null = null;
  if (!passed) {
    if (result.reason === "no-time-overlap") reason = `Their recorded times are more than ${formatSeconds(STITCH_TIME_PAD_S)} apart.`;
    else if (e.shorter_capture_s < STITCH_MIN_CAPTURE_S) reason = `One capture is shorter than ${formatSeconds(STITCH_MIN_CAPTURE_S)}, too short to match reliably.`;
    else if (snaps.some((snap) => (bodySegments(snap.body)?.length ?? 0) < 4)) reason = "One transcript has too few separate passages to check against the other.";
    else reason = "The two transcripts don't share enough of the same wording.";
  }
  return {
    passed,
    headline: passed ? "These look like the same meeting" : `These don't look like the same meeting (${e.matching_phrases} matching ${e.matching_phrases === 1 ? "phrase" : "phrases"})`,
    reason,
    lines,
  };
}

/** "Fireflies · Weekly sync" for a capture in the sheet. */
export function captureLabel(item: LibraryItem): string {
  return `${librarySourceLabel(item.source)} · ${item.title ?? "Untitled"}`;
}
