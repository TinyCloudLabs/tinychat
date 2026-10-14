import type { CalendarConnection, CalendarGoogleBrowserBinding } from "./calendar-autojoin-store.js";

interface Reference {
  subjectHash: string;
  /** An expired setup stops counting even before the cleanup tick. */
  expiresAt?: number;
}

export type GoogleGrantRevokeReason = "last_holder" | "shared_holder" | "index_unavailable" | "token_unindexed" | "reference_check_failed";
export interface GoogleGrantRevokeDecision { revoke: boolean; reason: GoogleGrantRevokeReason }
export interface GrantBackfillSnapshot { revision: number; uncertainty: number }
interface TokenBinding { subjectHash: string; tokenHashes: Set<string> }

/**
 * Process-local projection under calendar autojoin's existing single-backend-writer contract.
 * Only digests enter this index. A restart/read failure requires a complete background backfill
 * before it can skip revocation. Disconnect never enumerates tenants or reads their credentials.
 */
export class CalendarAutojoinGrantIndex {
  private readonly subjects = new Map<string, Map<string, Reference>>();
  private readonly tenants = new Map<string, { subjectHash: string; revision: number }>();
  // Two digests per binding, never tokens. Keep detached bindings for the SPA's second call.
  // Server and browser can belong to different Google grants after interrupted replacement.
  private readonly serverTokens = new Map<string, TokenBinding>();
  private readonly browserTokens = new Map<string, TokenBinding>();
  private revision = 0;
  private uncertainty = 0;
  private trusted = false;

  constructor(private readonly hashSubject: (subject: string) => string,
    private readonly hashToken: (token: string) => string, private readonly now: () => number = Date.now) {}

  get needsBackfill(): boolean { return !this.trusted; }
  beginBackfill(): GrantBackfillSnapshot { return { revision: this.revision, uncertainty: this.uncertainty }; }

  completeBackfill(start: ReturnType<CalendarAutojoinGrantIndex["beginBackfill"]>, seen: Set<string>): void {
    for (const [tenant, ref] of this.tenants) {
      // A connect completed after listConnections' snapshot: keep its already-confirmed custody.
      if (!seen.has(tenant) && ref.revision <= start.revision) this.forget(tenant);
    }
    this.trusted = start.uncertainty === this.uncertainty;
  }

  invalidate(): void { this.trusted = false; this.uncertainty++; }

  browserBinding(subject: string, tokens: string[]): CalendarGoogleBrowserBinding {
    return { version: 1, subjectHash: this.hashSubject(subject), tokenHashes: [...new Set(tokens.map(token => this.hashToken(token)))] };
  }

  restoreBrowser(tenant: string, binding: CalendarGoogleBrowserBinding): void {
    const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (binding.version !== 1 || !digest(binding.subjectHash) || !Array.isArray(binding.tokenHashes)
      || binding.tokenHashes.length > 2 || !binding.tokenHashes.every(digest)) throw new Error("google_browser_binding_invalid");
    const key = tenant.toLowerCase();
    this.browserTokens.set(key, { subjectHash: binding.subjectHash, tokenHashes: new Set(binding.tokenHashes) });
    if (!this.tenants.has(key)) this.tenants.set(key, { subjectHash: binding.subjectHash, revision: ++this.revision });
  }

  bindBrowser(tenant: string, subject: string, tokens: string[]): CalendarGoogleBrowserBinding {
    const key = tenant.toLowerCase();
    const binding = this.browserBinding(subject, tokens);
    if (this.tenants.get(key)?.subjectHash !== binding.subjectHash) this.detach(key);
    this.tenants.set(key, { subjectHash: binding.subjectHash, revision: ++this.revision });
    this.restoreBrowser(key, binding);
    return binding;
  }

  /** Called only with a matching, usable server OAuth credential under tenant coordination. */
  hold(row: CalendarConnection, tokens: string[], browserConfirmed = false): void {
    const tenant = row.tenant.toLowerCase();
    this.detach(tenant);
    if (!row.subject || !liveGoogleConnection(row, this.now())) return;
    const subjectHash = this.hashSubject(row.subject);
    const reference: Reference = { subjectHash, ...(row.state === "enabling" ? { expiresAt: row.setupExpiresAt } : {}) };
    const holders = this.subjects.get(subjectHash) ?? new Map<string, Reference>();
    holders.set(tenant, reference);
    this.subjects.set(subjectHash, holders);
    this.tenants.set(tenant, { subjectHash, revision: ++this.revision });
    const binding = { subjectHash, tokenHashes: new Set(tokens.map(token => this.hashToken(token))) };
    this.serverTokens.set(tenant, binding);
    if (browserConfirmed) this.browserTokens.set(tenant, binding);
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

  forget(tenant: string): void {
    const key = tenant.toLowerCase();
    this.detach(key); this.tenants.delete(key); this.serverTokens.delete(key); this.browserTokens.delete(key);
  }

  /** Synchronous decrement-and-check: the last concurrent disconnect always chooses revoke. */
  release(tenant: string, tokens: string[]): GoogleGrantRevokeDecision[] {
    const key = tenant.toLowerCase();
    this.detach(key);
    if (!this.trusted) return tokens.map(() => ({ revoke: true, reason: "index_unavailable" }));
    const bindings = [this.serverTokens.get(key), this.browserTokens.get(key)];
    return tokens.map(token => {
      const digest = this.hashToken(token);
      const binding = bindings.find(candidate => candidate?.tokenHashes.has(digest));
      return binding ? this.decide(binding.subjectHash) : { revoke: true, reason: "token_unindexed" };
    });
  }

  private decide(subjectHash: string): GoogleGrantRevokeDecision {
    const holders = this.subjects.get(subjectHash);
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
