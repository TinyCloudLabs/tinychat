import type { CalendarConnection } from "./calendar-autojoin-store.js";

interface Reference {
  subjectHash: string;
  /** An expired setup stops counting even before the cleanup tick. */
  expiresAt?: number;
}

export type GoogleGrantRevokeReason = "last_holder" | "shared_holder" | "index_unavailable" | "tenant_unindexed" | "reference_check_failed";
export interface GoogleGrantRevokeDecision { revoke: boolean; reason: GoogleGrantRevokeReason }

/**
 * Process-local projection under calendar autojoin's existing single-backend-writer contract.
 * Only digests enter this index. A restart/read failure requires a complete background backfill
 * before it can skip revocation. Disconnect never enumerates tenants or reads their credentials.
 */
export class CalendarAutojoinGrantIndex {
  private readonly subjects = new Map<string, Map<string, Reference>>();
  // Keep a detached binding for the SPA's second (browser-token) disconnect call. This is NOT
  // a live reference. Ordinary account replacement forgets it: the vault then holds a new grant.
  private readonly tenants = new Map<string, { subjectHash: string; revision: number }>();
  private revision = 0;
  private uncertainty = 0;
  private trusted = false;

  constructor(private readonly hashSubject: (subject: string) => string, private readonly now: () => number = Date.now) {}

  get needsBackfill(): boolean { return !this.trusted; }
  beginBackfill() { return { revision: this.revision, uncertainty: this.uncertainty }; }

  completeBackfill(start: ReturnType<CalendarAutojoinGrantIndex["beginBackfill"]>, seen: Set<string>): void {
    for (const [tenant, ref] of this.tenants) {
      // A connect completed after listConnections' snapshot: keep its already-confirmed custody.
      if (!seen.has(tenant) && ref.revision <= start.revision) this.forget(tenant);
    }
    this.trusted = start.uncertainty === this.uncertainty;
  }

  invalidate(): void { this.trusted = false; this.uncertainty++; }

  /** Called only with a matching, usable server OAuth credential under tenant coordination. */
  hold(row: CalendarConnection): void {
    const tenant = row.tenant.toLowerCase();
    this.detach(tenant);
    if (!row.subject || !liveGoogleConnection(row, this.now())) return;
    const subjectHash = this.hashSubject(row.subject);
    const reference: Reference = { subjectHash, ...(row.state === "enabling" ? { expiresAt: row.setupExpiresAt } : {}) };
    const holders = this.subjects.get(subjectHash) ?? new Map<string, Reference>();
    holders.set(tenant, reference);
    this.subjects.set(subjectHash, holders);
    this.tenants.set(tenant, { subjectHash, revision: ++this.revision });
  }

  /** Local Disable/needs_reconnect stops counting but remembers this process's known binding. */
  detach(tenant: string): void {
    const key = tenant.toLowerCase();
    const binding = this.tenants.get(key);
    if (!binding) return;
    const holders = this.subjects.get(binding.subjectHash);
    holders?.delete(key);
    if (!holders?.size) this.subjects.delete(binding.subjectHash);
    binding.revision = ++this.revision;
  }

  forget(tenant: string): void { this.detach(tenant); this.tenants.delete(tenant.toLowerCase()); }

  /** Synchronous decrement-and-check: the last concurrent disconnect always chooses revoke. */
  release(tenant: string): GoogleGrantRevokeDecision {
    const key = tenant.toLowerCase();
    const binding = this.tenants.get(key);
    this.detach(key);
    if (!this.trusted) return { revoke: true, reason: "index_unavailable" };
    if (!binding) return { revoke: true, reason: "tenant_unindexed" };
    const holders = this.subjects.get(binding.subjectHash);
    if (holders) {
      for (const ref of holders.values()) {
        if (ref.expiresAt === undefined || ref.expiresAt > this.now()) return { revoke: false, reason: "shared_holder" };
      }
    }
    return { revoke: true, reason: "last_holder" };
  }
}

/** Disabled/reconnect rows can retain crash residue; that custody is no longer usable policy. */
export function liveGoogleConnection(row: CalendarConnection, now: number): boolean {
  return !!row.subject && row.credentialRef === "google-calendar"
    && (row.state === "enabled" || row.state === "enabling" && (row.setupExpiresAt ?? 0) > now);
}
