// Every user-facing string of the Granola CSV import, in one place for copy review.
// Strings marked MOCK are the approved mock's, verbatim.

import type { GranolaCsvImportCounts, GranolaCsvImportFailure } from "./granolaCsvImport";

/** The purge ledger Granola keeps with the backend; Fireflies has its own. */
export const GRANOLA_LEDGER_SOURCE = "granola";

export const GRANOLA_EXPORT_URL = "https://grano.la/app?path=%2Fsettings%2Fprofile";

export const GRANOLA_CSV_STRINGS = {
  // MOCK
  dialogDescription: "Bring notes and transcripts into your private space.",
  eyebrow: "Basic (free) · One-time import",
  heading: "Import a Granola export",
  getStarted: "Get started",
  hideSteps: "Hide steps",
  guideTitle: "Export your notes from Granola",
  exportLink: "Open Granola's export settings",
  linkFallback: "Link doesn't work? In Granola, go to Settings, then Profile.",
  steps: [
    "Click Generate CSV.",
    "Choose the workspaces to export.",
    "Download the CSV from Granola's email.",
  ],
  upload: "Upload the CSV",
  autoHeading: "Automatic sync",
  autoPlan: "Granola Business or Enterprise only.",
  connectWithKey: "Connect with an API key",
  // NEW
  stepLabel: (n: number) => `Step ${n}`,
  importing: "Importing your meetings…",
  importingProgress: (done: number, total: number) => `Importing ${done} of ${total} meetings…`,
  allowBack: "Allow deleted meetings back",
  allowBackNote: "Meetings you deleted come back only if they're in a CSV you upload and you say yes.",
  allowingBack: "Allowing…",
  allowBackFailed: "Couldn't allow deleted meetings back. Try again.",
  allowBackDone: "Deleted meetings can be imported again. Upload the CSV to bring them in.",
  chooseAnother: "Upload another CSV",
} as const;

/** Same flow and the same words as the Fireflies "allow deleted meetings back" confirmation, for an import. */
export const GRANOLA_RESYNC_CONFIRM = {
  heading: "Allow deleted meetings back?",
  body:
    "We keep a list of the meetings you deleted, so an import doesn't bring them back. If you clear it, any of those meetings in a CSV you upload are imported again. This can't be undone.",
  confirmLabel: "Allow them back",
  cancelLabel: "Keep them deleted",
} as const;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One line per thing that happened; the first line is the headline. */
export function granolaCsvSummaryLines(counts: GranolaCsvImportCounts): string[] {
  const lines: string[] = [];
  if (counts.added > 0) lines.push(`${plural(counts.added, "meeting", "meetings")} imported.`);
  else if (counts.alreadyImported > 0 && counts.skippedDeleted === 0 && counts.failed === 0) {
    lines.push("Nothing new to import. These meetings are already in your space.");
  } else if (counts.skippedDeleted === 0 && counts.failed === 0) {
    lines.push("There were no meetings in that file. Upload the CSV from Granola's email.");
  }
  if (counts.added > 0 && counts.alreadyImported > 0) {
    lines.push(`${plural(counts.alreadyImported, "meeting was", "meetings were")} already in your space.`);
  }
  if (counts.duplicatesInFile > 0) {
    lines.push(`${plural(counts.duplicatesInFile, "repeat", "repeats")} in the file ${counts.duplicatesInFile === 1 ? "was" : "were"} skipped.`);
  }
  if (counts.skippedDeleted > 0) {
    lines.push(`${plural(counts.skippedDeleted, "meeting was", "meetings were")} skipped because you deleted ${counts.skippedDeleted === 1 ? "it" : "them"}.`);
  }
  if (counts.blank > 0) {
    lines.push(`${plural(counts.blank, "row", "rows")} with no title or notes ${counts.blank === 1 ? "was" : "were"} skipped.`);
  }
  if (counts.failed > 0) {
    lines.push(`${plural(counts.failed, "meeting", "meetings")} couldn't be saved. Upload the CSV again; meetings already imported are skipped.`);
  }
  return lines;
}

/** A plain error with a next step. */
export function granolaCsvErrorMessage(error: GranolaCsvImportFailure): string {
  switch (error.kind) {
    case "malformed":
      switch (error.csv.code) {
        case "empty":
          return "That file is empty. Download the CSV from Granola's email, then upload it again.";
        case "no-known-columns":
          return "We couldn't find meeting columns in that file. Upload the CSV from Granola's email.";
        default:
          return "We couldn't read that file, so nothing was imported. Upload the CSV from Granola's email.";
      }
    case "purge-check":
      return "Couldn't check which meetings you deleted, so the import stopped. Try again.";
    case "storage":
      return error.full
        ? "Your space is full. Free up some space, then upload the CSV again."
        : "Couldn't save your meetings. Try again.";
    case "aborted":
      return "The import stopped. Upload the CSV again to continue.";
  }
}
