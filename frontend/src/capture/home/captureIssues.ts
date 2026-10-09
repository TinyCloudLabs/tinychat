// What the recorder says went wrong with a recording (TC-866), as the Recent
// rows and the "on this phone" card show it. Pure: the provider's
// `captureIssues` map in, row models and one line of copy out. An issue's
// `detail` is diagnostic and never reaches this file's output.
import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { LibraryItem } from "../library/LibraryRow";
import { FINALIZATION_PENDING } from "../recorder/recorderCopy";
import { HOME_COPY } from "./homeCopy";

/** The recorder's issues, plus a session native gave up on and parked with its audio kept (`listQuarantine`). */
export type HomeIssue = RecorderCaptureIssue | { kind: "quarantined" };

export type CaptureIssues = Readonly<Record<string, HomeIssue>>;

/** The row's state line for an issue. */
export function issueMeta(issue: HomeIssue): string {
  switch (issue.kind) {
    case "finalization_timed_out":
      return HOME_COPY.timedOutMeta;
    case "recoveryFailed":
      return HOME_COPY.recoveryFailedMeta;
    case "quarantined":
      return HOME_COPY.quarantinedMeta;
    case "write_failed":
      return HOME_COPY.writeFailedMeta;
  }
}

/** Whether Try again and Delete can apply: the recording could not be recovered, and its audio is still on the phone. */
export function issueIsRecoverable(
  issue: HomeIssue,
): issue is Extract<HomeIssue, { kind: "recoveryFailed" | "quarantined" }> {
  return issue.kind === "recoveryFailed" || issue.kind === "quarantined";
}

/** Changes when a recording newly fails recovery (or stops failing): the cue to read what native has parked. */
export function recoveryFailedKey(
  issues: Readonly<Record<string, RecorderCaptureIssue>>,
): string {
  return Object.keys(issues)
    .filter((id) => issues[id]!.kind === "recoveryFailed")
    .sort()
    .join(",");
}

/**
 * The recorder's issues with what native parked: a quarantined session
 * replaces a `recoveryFailed` one (same recording, now with its audio kept),
 * and a recording the user deleted drops out.
 */
export function withQuarantine(
  issues: Readonly<Record<string, RecorderCaptureIssue>>,
  quarantinedIds: readonly string[],
  deletedIds: ReadonlySet<string>,
): CaptureIssues {
  const merged: Record<string, HomeIssue> = { ...issues };
  for (const id of quarantinedIds) {
    const current = merged[id];
    if (current === undefined || current.kind === "recoveryFailed")
      merged[id] = { kind: "quarantined" };
  }
  for (const id of deletedIds) delete merged[id];
  return merged;
}

/** The issues whose Library row opens a sheet instead of its note; a timed-out one resolves itself, so its row still opens the note. */
export function issueHasSheet(issue: HomeIssue): boolean {
  return issue.kind !== "finalization_timed_out";
}

export function issueSheetCopy(issue: HomeIssue): {
  title: string;
  body: string;
} {
  switch (issue.kind) {
    case "finalization_timed_out":
      return HOME_COPY.timedOutSheet;
    case "recoveryFailed":
      return HOME_COPY.recoveryFailedSheet;
    case "quarantined":
      return HOME_COPY.quarantinedSheet;
    case "write_failed":
      return HOME_COPY.writeFailedSheet;
  }
}

/** The issue an open sheet shows: the provider's current one for that recording, none once it clears or the skin is off. */
export function sheetIssue(
  id: string | null,
  issues: CaptureIssues,
  enabled: boolean,
): HomeIssue | null {
  return enabled && id !== null ? (issues[id] ?? null) : null;
}

/** The issue a Library item carries: a voice note whose recording id has one. */
export function issueForItem(
  item: LibraryItem,
  issues: CaptureIssues,
): HomeIssue | undefined {
  return item.source === VOICE_NOTE_SOURCE ? issues[item.sourceId] : undefined;
}

export interface OrphanIssue {
  id: string;
  issue: HomeIssue;
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
    .filter((id) => !inLibrary.has(id))
    .reverse()
    .map((id) => ({ id, issue: issues[id]! }));
}

export type RecentEntry =
  | { type: "item"; item: LibraryItem; issue?: HomeIssue }
  | { type: "issue"; id: string; issue: HomeIssue };

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
 * The "on this phone" card's second line. A save error shows as it is, except
 * the "Exo will finish it automatically" one (FINALIZATION_PENDING): a
 * recording that could not be recovered or fully written outranks that, and
 * the card never says both. Nothing wrong keeps the plain line.
 */
export function cardNote(
  issues: CaptureIssues,
  lastError: string | null,
): string {
  if (lastError && lastError !== FINALIZATION_PENDING) return lastError;
  const kinds = Object.values(issues).map((issue) => issue.kind);
  if (kinds.includes("recoveryFailed") || kinds.includes("quarantined"))
    return `${HOME_COPY.notInSpace} · ${HOME_COPY.willRetry}`;
  if (kinds.includes("write_failed"))
    return `${HOME_COPY.notInSpace} · ${HOME_COPY.writeFailedMeta}`;
  if (lastError || kinds.includes("finalization_timed_out"))
    return HOME_COPY.willFinish;
  return HOME_COPY.notInSpace;
}
