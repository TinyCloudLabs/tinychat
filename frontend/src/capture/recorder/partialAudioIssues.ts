import type { RecorderCaptureIssue } from "./recorderReducer";

type PartialAudioIssue = Extract<RecorderCaptureIssue, { kind: "partial_audio" }>;
interface StoredNotice { issue?: PartialAudioIssue; dismissedAt?: number; lossAt?: number }
type StoredNotices = Record<string, StoredNotice>;
const prefix = "exo.voiceNotes.partialAudio.";
const MAX_NOTICES = 256;
const UNKNOWN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Keep each account and space separate, including the signed-out local bucket. */
export const partialAudioScope = (did: string | null | undefined, spaceId: string | null | undefined) =>
  `${prefix}${encodeURIComponent(did ?? "signed-out")}.${encodeURIComponent(spaceId ?? "local")}`;

function read(scope: string): StoredNotices {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(scope) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, StoredNotice] => {
      const notice = entry[1] as StoredNotice | null;
      return notice !== null && typeof notice === "object" &&
        (notice.issue?.kind === "partial_audio" || typeof notice.dismissedAt === "number" || typeof notice.lossAt === "number");
    }));
  } catch { return {}; }
}

function write(scope: string, notices: StoredNotices): boolean {
  try { localStorage.setItem(scope, JSON.stringify(notices)); return true; } catch { return false; }
}

export const savedPartialAudioIssues = (scope: string): Record<string, PartialAudioIssue> =>
  Object.fromEntries(Object.entries(read(scope)).flatMap(([id, notice]) =>
    notice.issue && notice.dismissedAt === undefined ? [[id, notice.issue]] : []));
export const partialAudioDismissed = (scope: string, id: string) => read(scope)[id]?.dismissedAt !== undefined;
export const pendingAudioLossIds = (scope: string) => new Set(Object.entries(read(scope))
  .filter((entry) => entry[1].lossAt !== undefined && entry[1].dismissedAt === undefined).map(([id]) => id));

export function savePendingAudioLoss(scope: string, id: string): void {
  const notices = read(scope);
  if (notices[id]?.dismissedAt !== undefined) return;
  notices[id] = { ...notices[id], lossAt: notices[id]?.lossAt ?? Date.now() };
  write(scope, notices);
}

export function savePartialAudioIssue(scope: string, id: string, issue: PartialAudioIssue): void {
  const notices = read(scope);
  if (notices[id]?.dismissedAt !== undefined) return;
  notices[id] = { issue };
  // A write failure has no durable stop reason in the v2 sidecar. If storage
  // is unavailable, a later launch can restore only writer-stall spans.
  write(scope, notices);
}

export function dismissPartialAudioIssue(scope: string, id: string): boolean {
  const notices = read(scope);
  notices[id] = { dismissedAt: Date.now() };
  return write(scope, notices);
}

export function clearPartialAudioIssue(scope: string, id: string, announce = true): void {
  const notices = read(scope);
  delete notices[id];
  write(scope, notices);
  if (announce && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("exo:captureIssueDeleted", { detail: { id } }));
}

/** A local Delete knows the recording id, but may run after account handoff. */
export function clearDeletedPartialAudioIssue(id: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) clearPartialAudioIssue(key, id, false);
    }
  } catch { /* Storage may be unavailable. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("exo:captureIssueDeleted", { detail: { id } }));
}

/** Keep recent upload dismissals until retained shell events have aged out. */
export function prunePartialAudioIssues(scope: string, knownIds: ReadonlySet<string>, now = Date.now()): void {
  const notices = read(scope);
  for (const [id, notice] of Object.entries(notices)) {
    const age = notice.dismissedAt ?? notice.lossAt;
    if (!knownIds.has(id) && age !== undefined && now - age > UNKNOWN_RETENTION_MS)
      delete notices[id];
  }
  const dismissed = Object.entries(notices).filter((entry) => entry[1].dismissedAt !== undefined)
    .sort((a, b) => (b[1].dismissedAt ?? 0) - (a[1].dismissedAt ?? 0));
  for (const [id] of dismissed.slice(MAX_NOTICES)) delete notices[id];
  const pending = Object.entries(notices).filter((entry) => entry[1].lossAt !== undefined && !entry[1].issue)
    .sort((a, b) => (b[1].lossAt ?? 0) - (a[1].lossAt ?? 0));
  for (const [id] of pending.slice(MAX_NOTICES)) delete notices[id];
  write(scope, notices);
}
