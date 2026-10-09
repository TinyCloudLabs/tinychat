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
  }
}

/** The two issues that open a sheet; a timed-out one resolves itself. */
export function issueHasSheet(issue: RecorderCaptureIssue): boolean {
  return issue.kind !== "finalization_timed_out";
}

export function issueSheetCopy(
  issue: RecorderCaptureIssue,
): { title: string; body: string } | null {
  if (issue.kind === "recoveryFailed") return HOME_COPY.recoveryFailedSheet;
  if (issue.kind === "write_failed") return HOME_COPY.writeFailedSheet;
  return null;
}

/** The issue a Library item carries: a voice note whose recording id has one. */
export function issueForItem(
  item: LibraryItem,
  issues: CaptureIssues,
): RecorderCaptureIssue | undefined {
  return item.source === VOICE_NOTE_SOURCE ? issues[item.sourceId] : undefined;
}

export type RecentEntry =
  | { type: "item"; item: LibraryItem; issue?: RecorderCaptureIssue }
  | { type: "issue"; id: string; issue: RecorderCaptureIssue };

/**
 * Recent's rows: a recording with an issue and no Library row yet (it is not in
 * the space) comes first, newest issue first; then the Library's latest, up to
 * `limit` rows in all. An issue row is never cut to make room.
 */
export function recentEntries(
  items: readonly LibraryItem[],
  issues: CaptureIssues,
  limit: number,
): RecentEntry[] {
  const inLibrary = new Set(
    items
      .filter((item) => item.source === VOICE_NOTE_SOURCE)
      .map((item) => item.sourceId),
  );
  const orphans: RecentEntry[] = Object.keys(issues)
    .filter((id) => !inLibrary.has(id))
    .reverse()
    .map((id) => ({ type: "issue", id, issue: issues[id]! }));
  const rest = items
    .slice(0, Math.max(0, limit - orphans.length))
    .map(
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
    return `${HOME_COPY.notInSpace} · ${HOME_COPY.willFinish}`;
  return HOME_COPY.notInSpace;
}
