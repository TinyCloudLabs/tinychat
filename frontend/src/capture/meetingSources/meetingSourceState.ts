export type MeetingSourceState = "connected" | "disconnected" | "syncing" | "connecting";

export function meetingSourceStatus(state: MeetingSourceState, syncedAgo?: string | null, count = 0): string {
  if (state === "connected") return `Connected · synced ${syncedAgo ?? "recently"} · ${count} meetings`;
  if (state === "syncing") return "Syncing…";
  if (state === "connecting") return "Connecting…";
  return "Not connected";
}

export function meetingSourceActionBusy(state: MeetingSourceState): boolean {
  return state === "syncing" || state === "connecting";
}
