import { type BoardRecord, legacyUrgency } from "./schema";

export type Quadrant = "Q1" | "Q2" | "Q3" | "Q4";

/** Stored dimensions override the kind's effective defaults without changing the KV record. */
export function effectivePriority(record: BoardRecord): { urgency: number; importance: number } {
  const severity = record.kind === "incident" ? ({ sev1: 5, sev2: 4, sev3: 3 } as const)[record.severity ?? "sev3"] : undefined;
  const urgency = typeof record.urgency === "string" ? legacyUrgency[record.urgency] : record.urgency;
  return { urgency: urgency ?? severity ?? 2, importance: record.importance ?? severity ?? 2 };
}

export function quadrant(record: BoardRecord): Quadrant {
  const { urgency, importance } = effectivePriority(record);
  return urgency >= 3 ? importance >= 3 ? "Q1" : "Q2" : importance >= 3 ? "Q3" : "Q4";
}

/** Q1–Q4, then descending combined priority, oldest creation, stable id. */
export function compareMatrix(a: BoardRecord, b: BoardRecord): number {
  const pa = effectivePriority(a);
  const pb = effectivePriority(b);
  const qa = pa.urgency >= 3 ? pa.importance >= 3 ? 1 : 2 : pa.importance >= 3 ? 3 : 4;
  const qb = pb.urgency >= 3 ? pb.importance >= 3 ? 1 : 2 : pb.importance >= 3 ? 3 : 4;
  return qa - qb || (pb.urgency + pb.importance) - (pa.urgency + pa.importance) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
