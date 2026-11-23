import type { OwnerDid, StandingArea } from "./standing-types.js";

export type ReadOutcome = "ok" | "off" | "no_grant" | "not_owner" | "expired" | "revoked" | "budget" | "busy" | "not_found" | "unavailable" | "error";

export interface ReadAuditAttempt {
  at: string;
  owner: OwnerDid;
  area: StandingArea;
  tool: string;
}

export interface ReadAudit {
  /** Commits the attempt before the tool can read. A write failure refuses the read. */
  begin(a: ReadAuditAttempt): Promise<string>;
  settle(id: string, outcome: ReadOutcome): Promise<void>;
  summary(owner: OwnerDid, fromIso: string, toIso: string): Promise<ReadSummary>;
}

export interface ReadSummary {
  owner: OwnerDid;
  from: string;
  to: string;
  days: { day: string; area: StandingArea; tool: string; ok: number; refused: number }[];
  total: number;
}
