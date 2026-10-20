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

/** The last finished sync's persisted outcome, when it was not clean. */
export type PersistedSyncProblem = "error" | "partial";

export function persistedSyncProblem(
  connection: { status: string; lastSyncStatus: string | null; lastSyncError: string | null } | null,
): { kind: PersistedSyncProblem; message: string | null } | null {
  if (connection?.status !== "connected") return null;
  if (connection.lastSyncStatus !== "error" && connection.lastSyncStatus !== "partial") return null;
  return { kind: connection.lastSyncStatus, message: connection.lastSyncError };
}

export function meetingSourceStatus(
  state: MeetingSourceState,
  syncedAgoText?: string | null,
  count: number | null = 0,
  problem: PersistedSyncProblem | null = null,
): MeetingSourceStatus {
  switch (state) {
    case "connected": {
      const lead =
        problem === "error"
          ? "Last sync failed"
          : problem === "partial"
            ? "Last sync incomplete"
            : "Connected";
      return {
        tone: "on",
        text: `${lead} · synced ${syncedAgoText ?? "never"}${count === null ? "" : ` · ${meetingCount(count)}`}`,
      };
    }
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
  sources: readonly { name: string; connected: boolean; count: number | null }[],
): string {
  const connected = sources.filter((source) => source.connected);
  if (connected.length === 0) return "Nothing connected yet";
  const names = connected.map((source) => source.name).join(" and ");
  // A count that has not been read yet is left out rather than shown as 0.
  if (connected.some((source) => source.count === null)) return `${names} connected`;
  const total = connected.reduce((sum, source) => sum + (source.count ?? 0), 0);
  return `${names} connected · ${meetingCount(total)}`;
}

/** What one source row shows: its state, its status line, and the one error to put under it. */
export function sourceRowDisplay(input: {
  comingSoon: boolean;
  connection: {
    status: string;
    lastSyncedAt: string | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    itemCount: number;
  } | null;
  /** Overrides the stored count: Google Meet's is the live count of saved meetings, null until read. */
  itemCount?: number | null;
  syncing: boolean;
  connecting: boolean;
  /** This window's own sync failure for the row, if the last attempt failed. */
  syncError: string | null;
  /** A disconnect warning left on the row. */
  rowNote: string | null;
}): { state: MeetingSourceState; status: MeetingSourceStatus | null; error: string | null } {
  const { connection } = input;
  const connected = connection?.status === "connected";
  // "Connecting" only until the connection row exists: once it is written (even with a
  // sync error) the row is connected, whatever the open connect dialog still shows.
  const state: MeetingSourceState = input.syncing
    ? "syncing"
    : input.connecting && !connected
      ? "connecting"
      : connected
        ? "connected"
        : "disconnected";
  const problem = persistedSyncProblem(connection);
  const status = input.comingSoon
    ? null
    : meetingSourceStatus(
        state,
        syncedAgo(connection?.lastSyncedAt),
        input.itemCount !== undefined ? input.itemCount : (connection?.itemCount ?? 0),
        problem?.kind ?? null,
      );
  // The current attempt's failure wins over what the last finished sync saved.
  return { state, status, error: input.syncError ?? input.rowNote ?? problem?.message ?? null };
}
