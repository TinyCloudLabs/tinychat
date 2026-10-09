// What the recorder says went wrong with a recording (TC-866), as the Recent
// rows and the "on this phone" card show it. Pure: the provider's
// `captureIssues` map in, row models and one line of copy out. An issue's
// `detail` is diagnostic and never reaches this file's output.
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { LibraryItem } from "../library/LibraryRow";
import { HOME_COPY } from "./homeCopy";

export type CaptureIssues = Readonly<Record<string, RecorderCaptureIssue>>;

/** The row's state line for an issue. */
export function issueMeta(issue: RecorderCaptureIssue): string {
  switch (issue.kind) {
    case "finalization_timed_out":
      return HOME_COPY.timedOutMeta;
    case "recoveryFailed":
      return HOME_COPY.recoveryFailedMeta;
    case "write_failed":
      return HOME_COPY.writeFailedMeta;
    case "partial_audio":
      return ""; // Informational notice; the recorder-final UI supplies its copy.
  }
}

/** The issues whose Library row opens a sheet instead of its note; a timed-out one resolves itself, so its row still opens the note. */
export function issueHasSheet(issue: RecorderCaptureIssue): boolean {
  return issue.kind !== "finalization_timed_out" && issue.kind !== "partial_audio";
}

export function issueSheetCopy(issue: RecorderCaptureIssue): {
  title: string;
  body: string;
} | null {
  switch (issue.kind) {
    case "finalization_timed_out":
      return HOME_COPY.timedOutSheet;
    case "recoveryFailed":
      return HOME_COPY.recoveryFailedSheet;
    case "write_failed":
      return HOME_COPY.writeFailedSheet;
    case "partial_audio":
      return null; // Informational notices do not open an error sheet.
  }
}

/** The issue an open sheet shows: the provider's current one for that recording, none once it clears or the skin is off. */
export function sheetIssue(
  id: string | null,
  issues: CaptureIssues,
  enabled: boolean,
): RecorderCaptureIssue | null {
  const issue = enabled && id !== null ? issues[id] : undefined;
  return issue?.kind === "partial_audio" ? null : issue ?? null;
}

/** The issue a Library item carries: a voice note whose recording id has one. */
export function issueForItem(
  item: LibraryItem,
  issues: CaptureIssues,
): RecorderCaptureIssue | undefined {
  const issue = item.source === VOICE_NOTE_SOURCE ? issues[item.sourceId] : undefined;
  return issue?.kind === "partial_audio" ? undefined : issue;
}

export interface OrphanIssue {
  id: string;
  issue: RecorderCaptureIssue;
}

/**
 * Recordings with an issue and no Library row yet (they are not in the space),
 * newest issue first. Recent and the Library list both show these.
 */
export function orphanIssues(
  items: readonly LibraryItem[],
  issues: CaptureIssues,
): OrphanIssue[] {
  const inLibrary = new Set(
    items
      .filter((item) => item.source === VOICE_NOTE_SOURCE)
      .map((item) => item.sourceId),
  );
  return Object.keys(issues)
    .filter((id) => !inLibrary.has(id) && issues[id]?.kind !== "partial_audio")
    .reverse()
    .map((id) => ({ id, issue: issues[id]! }));
}

export type RecentEntry =
  | { type: "item"; item: LibraryItem; issue?: RecorderCaptureIssue }
  | { type: "issue"; id: string; issue: RecorderCaptureIssue };

/**
 * Recent's rows: the recordings with an issue and no Library row come first
 * (`orphanIssues`); then the Library's latest, up to `limit` rows in all. An
 * issue row is never cut to make room.
 */
export function recentEntries(
  items: readonly LibraryItem[],
  issues: CaptureIssues,
  limit: number,
): RecentEntry[] {
  const orphans: RecentEntry[] = orphanIssues(items, issues).map(
    (orphan): RecentEntry => ({ type: "issue", ...orphan }),
  );
  const rest = items.slice(0, Math.max(0, limit - orphans.length)).map(
    (item): RecentEntry => ({
      type: "item",
      item,
      issue: issueForItem(item, issues),
    }),
  );
  return [...orphans, ...rest];
}

/**
 * The "on this phone" card's second line. A recording that could not be
 * recovered overrides "Exo will finish it automatically": the card never says
 * both. Nothing wrong with any of them keeps the plain line.
 */
export function cardNote(
  issues: CaptureIssues,
  lastError: string | null,
): string {
  if (lastError) return lastError;
  const kinds = Object.values(issues).map((issue) => issue.kind);
  if (kinds.includes("recoveryFailed"))
    return `${HOME_COPY.notInSpace} · ${HOME_COPY.willRetry}`;
  if (kinds.includes("finalization_timed_out"))
    return HOME_COPY.willFinish;
  return HOME_COPY.notInSpace;
}
