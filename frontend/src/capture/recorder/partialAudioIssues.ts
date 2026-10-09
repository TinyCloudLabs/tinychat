import type { RecorderCaptureIssue } from "./recorderReducer";

type PartialAudioIssue = Extract<RecorderCaptureIssue, { kind: "partial_audio" }>;
const issueKey = "exo.voiceNotes.partialAudioIssues";
const dismissalKey = (id: string) => `exo.voiceNotes.partialAudioDismissed.${id}`;

function readIssues(): Record<string, PartialAudioIssue> {
  try {
    const value = JSON.parse(localStorage.getItem(issueKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, PartialAudioIssue] =>
      typeof entry[1] === "object" && entry[1] !== null && (entry[1] as PartialAudioIssue).kind === "partial_audio"));
  } catch { return {}; }
}

export const savedPartialAudioIssues = () => readIssues();
export const partialAudioDismissed = (id: string) => {
  try { return localStorage.getItem(dismissalKey(id)) === "1"; } catch { return false; }
};
export function savePartialAudioIssue(id: string, issue: PartialAudioIssue): void {
  try { localStorage.setItem(issueKey, JSON.stringify({ ...readIssues(), [id]: issue })); } catch { /* Native sidecar is the fallback. */ }
}
export function dismissPartialAudioIssue(id: string): boolean {
  try {
    localStorage.setItem(dismissalKey(id), "1");
    clearPartialAudioIssue(id, false);
    return true;
  } catch { return false; }
}
export function clearPartialAudioIssue(id: string, clearDismissal = true): void {
  try {
    const issues = readIssues();
    delete issues[id];
    localStorage.setItem(issueKey, JSON.stringify(issues));
    if (clearDismissal) localStorage.removeItem(dismissalKey(id));
  } catch { /* Storage may be unavailable. */ }
  if (clearDismissal && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("exo:captureIssueDeleted", { detail: { id } }));
}
