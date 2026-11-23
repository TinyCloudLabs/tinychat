// What the last history read of each bot found: how many records had their full record context verified and how many
// are earlier records without one. Counts only, never keys or content.
import type { BotHistoryContextReport } from "./historyRead";

export interface HistoryContextStatus {
  bound: number;
  legacy: number;
}

const status = new Map<string, HistoryContextStatus>();

export function noteHistoryContext(botKey: string, report: BotHistoryContextReport): void {
  status.set(botKey, { bound: report.bound, legacy: report.legacy.length });
}

export function historyContextStatus(botKey: string): HistoryContextStatus | undefined {
  return status.get(botKey);
}
