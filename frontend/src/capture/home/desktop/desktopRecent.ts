// What the desktop Capture home's Recent and "on this Mac" card say, as pure
// functions of the Library's items and the recorder's capture issues. An
// issue's `detail` is diagnostic and never reaches this file's output.
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { LibraryItem } from "../../library/LibraryRow";
import { libraryKind } from "../../library/libraryKinds";
import { FINALIZATION_PENDING } from "../../recorder/recorderCopy";
import {
  type CaptureIssues,
  type HomeIssue,
} from "../captureIssues";
import { HOME_COPY } from "../homeCopy";
import { DESKTOP_HOME_COPY as COPY } from "./desktopCopy";

export type RecentFilter = "all" | "note" | "meeting";

/** The chips, in order: Uploads are in All only. */
export const RECENT_FILTERS: readonly { value: RecentFilter; label: string }[] =
  [
    { value: "all", label: "All" },
    { value: "note", label: "Notes" },
    { value: "meeting", label: "Meetings" },
  ];

/** Recent shows this many rows at most, after the filter. */
export const DESKTOP_RECENT_COUNT = 20;

type Issues = CaptureIssues;
type Failure = Exclude<HomeIssue, { kind: "partial_audio" }>;

export type DesktopEntry =
  | {
      type: "item";
      item: LibraryItem;
      startedAt: string | null;
      /** The recording's failure, if it has one. */
      issue?: Failure;
      /** The recording was saved with part of its audio missing: its id, for Dismiss. */
      partialId?: string;
    }
  | { type: "issue"; id: string; issue: Failure }
  | { type: "partial"; id: string };

export function matchesRecentFilter(
  source: string,
  filter: RecentFilter,
): boolean {
  return filter === "all" || libraryKind(source) === filter;
}

/**
 * Recent's rows. A recording with an issue and no Library row yet comes first
 * (a voice note, so it shows under All and Notes); then the Library's latest
 * that match the filter, up to `limit` rows in all. An issue row is never cut
 * to make room.
 */
export function desktopRecent(
  items: readonly LibraryItem[],
  issues: Issues,
  filter: RecentFilter,
  limit: number = DESKTOP_RECENT_COUNT,
): {
  attention: DesktopEntry[];
  items: Extract<DesktopEntry, { type: "item" }>[];
} {
  const inLibrary = new Set(
    items
      .filter((item) => item.source === VOICE_NOTE_SOURCE)
      .map((item) => item.sourceId),
  );
  const attention: DesktopEntry[] =
    filter === "meeting"
      ? []
      : Object.keys(issues)
          .filter((id) => !inLibrary.has(id))
          .reverse()
          .map((id): DesktopEntry => {
            const issue = issues[id]!;
            return issue.kind === "partial_audio"
              ? { type: "partial", id }
              : { type: "issue", id, issue };
          });
  const rows = items
    .filter((item) => matchesRecentFilter(item.source, filter))
    .slice(0, Math.max(0, limit - attention.length))
    .map((item): Extract<DesktopEntry, { type: "item" }> => {
      const issue =
        item.source === VOICE_NOTE_SOURCE ? issues[item.sourceId] : undefined;
      return {
        type: "item",
        item,
        startedAt: item.startedAt,
        ...(issue?.kind === "partial_audio"
          ? { partialId: item.sourceId }
          : issue
            ? { issue }
            : {}),
      };
    });
  return { attention, items: rows };
}

/** The state line a failed recording's row shows. */
export function desktopIssueMeta(issue: Failure): string {
  switch (issue.kind) {
    case "finalization_timed_out":
      return COPY.timedOut;
    case "recoveryFailed":
      return COPY.recoveryFailed;
    case "quarantined":
      return HOME_COPY.quarantinedMeta;
    case "write_failed":
      return COPY.writeFailed;
  }
}


/** Whether the row is a failure to flag with "!" and "Needs attention": a timed-out save resolves itself. */
export function issueNeedsAttention(issue: Failure): boolean {
  return issue.kind !== "finalization_timed_out";
}

export function onMacTitle(count: number): string {
  return count === 1 ? COPY.onMacOne : COPY.onMacMany(count);
}

/**
 * The "on this Mac" card's second line. A save error shows as it is, except
 * the "Exo will finish it automatically" one (FINALIZATION_PENDING): a
 * recording that could not be recovered or fully written outranks that.
 */
export function onMacNote(issues: Issues, lastError: string | null): string {
  if (lastError && lastError !== FINALIZATION_PENDING) return lastError;
  const kinds = Object.values(issues).map((issue) => issue.kind);
  if (kinds.includes("recoveryFailed"))
    return `${COPY.notInSpace} · ${COPY.willRetry}`;
  if (kinds.includes("quarantined"))
    return `${COPY.notInSpace} · ${HOME_COPY.quarantinedCard}`;
  if (kinds.includes("write_failed"))
    return `${COPY.notInSpace} · ${COPY.writeFailed}`;
  if (lastError || kinds.includes("finalization_timed_out"))
    return COPY.willFinish;
  return COPY.notInSpace;
}
