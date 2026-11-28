import { calendarOutcomeLabel, type CalendarAutojoinOutcome } from "./calendarAutojoinApi";

// TC-4461: Home tells the owner when a calendar auto-join recording ended failed. The facts come from the status the app
// already reads for calendar autojoin; this module only decides which failed recordings still count and what the card says.

/** A failed recording counts for a day after its start. */
export const FAILED_RECORDING_WINDOW_MS = 24 * 60 * 60_000;
/** How often Home reads the status again while it is open. */
export const FAILED_RECORDING_POLL_MS = 10 * 60_000;
/** The status lists at most 30 outcomes, so a longer dismissed list would only hold ids that can no longer appear. */
const DISMISSED_CAP = 60;

export const FAILED_RECORDING_COPY = {
  leadOne: "A meeting recording did not finish",
  leadMany: (count: number) => `${count} meeting recordings did not finish`,
  untitled: "Untitled meeting",
  mostRecent: "Most recent",
  dismiss: "Dismiss",
  dismissOne: (title: string) => `Dismiss notice about ${title}`,
  dismissMany: "Dismiss notice about these recordings",
} as const;

/** Failed recordings inside the window that the owner has not dismissed, newest first. A start in the future never counts. */
export function failedRecordingsToShow(outcomes: readonly CalendarAutojoinOutcome[], dismissed: ReadonlySet<string>, now: number): CalendarAutojoinOutcome[] {
  return outcomes
    .filter(outcome => outcome.reason === "failed" && outcome.start <= now && now - outcome.start < FAILED_RECORDING_WINDOW_MS && !dismissed.has(outcome.id))
    .sort((a, b) => b.start - a.start);
}

export interface FailedRecordingCard {
  lead: string;
  /** "Most recent, " on a card that counts several recordings, otherwise empty. */
  prefix: string;
  /** The event title of the most recent recording, as shown. */
  title: string;
  reason: string;
  dismissLabel: string;
  ids: string[];
}

/** `failed` must be newest first (failedRecordingsToShow). */
export function failedRecordingCard(failed: readonly CalendarAutojoinOutcome[]): FailedRecordingCard | null {
  const latest = failed[0];
  if (!latest) return null;
  const title = latest.title?.trim() || FAILED_RECORDING_COPY.untitled;
  const many = failed.length > 1;
  return {
    lead: many ? FAILED_RECORDING_COPY.leadMany(failed.length) : FAILED_RECORDING_COPY.leadOne,
    prefix: many ? `${FAILED_RECORDING_COPY.mostRecent}, ` : "",
    title,
    reason: calendarOutcomeLabel("failed", latest.failureCode),
    dismissLabel: many ? FAILED_RECORDING_COPY.dismissMany : FAILED_RECORDING_COPY.dismissOne(title),
    ids: failed.map(outcome => outcome.id),
  };
}

export interface FailedRecordingDismissals {
  read(subject: string): ReadonlySet<string>;
  /** Records the ids for this owner on this device and calls every listener. */
  write(subject: string, ids: readonly string[]): void;
  subscribe(listener: () => void): () => void;
}

/** `tcw.tc4461.failedRecordings.<did:pkh, lowercased>`: a JSON array of recording ids. */
const dismissalKey = (subject: string) => `tcw.tc4461.failedRecordings.${subject.toLowerCase()}`;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Per owner and per device, in localStorage. A storage that cannot be read answers "none dismissed", so the card shows
 * rather than hiding for good. One that cannot be written keeps the answer in memory for this page load.
 */
export function createFailedRecordingDismissals(storage: () => StorageLike | undefined = defaultStorage): FailedRecordingDismissals {
  const here = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  const stored = (subject: string): string[] => {
    try {
      const parsed = JSON.parse(storage()?.getItem(dismissalKey(subject)) ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch { return []; }
  };
  return {
    read(subject) {
      return new Set([...stored(subject), ...(here.get(subject) ?? [])]);
    },
    write(subject, ids) {
      const merged = [...new Set([...stored(subject), ...ids])].slice(-DISMISSED_CAP);
      here.set(subject, new Set([...(here.get(subject) ?? []), ...ids]));
      try { storage()?.setItem(dismissalKey(subject), JSON.stringify(merged)); } catch { /* Kept in memory for this load. */ }
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function defaultStorage(): StorageLike | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export const failedRecordingDismissals: FailedRecordingDismissals = createFailedRecordingDismissals();
