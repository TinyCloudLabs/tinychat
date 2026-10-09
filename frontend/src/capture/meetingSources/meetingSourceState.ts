export type MeetingSourceState = "connected" | "disconnected" | "syncing" | "connecting";

/** Filled dot = connected, hollow = not connected, pulsing = busy. Red only ever means recording. */
export type MeetingSourceTone = "on" | "off" | "busy";

export interface MeetingSourceStatus {
  tone: MeetingSourceTone;
  text: string;
}

export function meetingCount(count: number): string {
  return `${count} ${count === 1 ? "meeting" : "meetings"}`;
}

/** "42 minutes ago", "just now". An unparsable or missing stamp reads as "never". */
export function syncedAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function meetingSourceStatus(
  state: MeetingSourceState,
  syncedAgoText?: string | null,
  count = 0,
): MeetingSourceStatus {
  switch (state) {
    case "connected":
      return {
        tone: "on",
        text: `Connected · synced ${syncedAgoText ?? "never"} · ${meetingCount(count)}`,
      };
    case "syncing":
      return { tone: "busy", text: "Syncing…" };
    case "connecting":
      return { tone: "busy", text: "Connecting…" };
    case "disconnected":
      return { tone: "off", text: "Not connected" };
  }
}

export function meetingSourceActionBusy(state: MeetingSourceState): boolean {
  return state === "syncing" || state === "connecting";
}

/** The Capture entry's second line: which sources are connected and how many meetings they hold. */
export function meetingSourcesSummary(
  sources: readonly { name: string; connected: boolean; count: number }[],
): string {
  const connected = sources.filter((source) => source.connected);
  if (connected.length === 0) return "Nothing connected yet";
  const total = connected.reduce((sum, source) => sum + source.count, 0);
  return `${connected.map((source) => source.name).join(" and ")} connected · ${meetingCount(total)}`;
}
