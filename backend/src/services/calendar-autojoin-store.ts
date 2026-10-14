import { createHash } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import {
  BackendStorageLane, BackendStorageLaneTimeout, REQUEST_LANE_WAIT_MS, type BackendStorageLaneRunOptions,
} from "./backend-storage-lane.js";
import { normalizeGoogleMeetUrl } from "./google-calendar.js";
import type { CreateMeetingInput } from "./transcription-api.js";
import { CalendarAutojoinStatusCache, STATUS_CACHE_MAX_TENANTS, type CalendarAutojoinOffReason } from "./calendar-autojoin-status-cache.js";
import { calendarAutojoinOutcomes, type CalendarAutojoinStatusSummary } from "./calendar-autojoin-status-summary.js";

/** Internal digest-only binding; never included in the status or OAuth response. */
export interface CalendarGoogleBrowserBinding { version: 1; subjectHash: string; tokenHashes: string[] }

export interface CalendarConnection {
  tenant: string;
  subject: string | null;
  state: "disabled" | "enabling" | "enabled" | "needs_reconnect";
  generation: number;
  offReason?: CalendarAutojoinOffReason;
  consentAt?: number;
  scopes: string[];
  credentialRef?: string;
  nextScanAt: number;
  lastScanAt?: number;
  /** TC-988: latest actual POST's timing only; additive in the existing v1 JSON. */
  lastDispatchLag?: { sentAt: number; seconds: number; discovered: number };
  errorCode?: string;
  scanComplete: boolean;
  setupId?: string;
  setupExpiresAt?: number;
  /** Lowercased Google email, only when the ID token verified it (TC-581). Never sent to the browser. */
  verifiedEmail?: string;
  /** Survives backend replacement and server-credential deletion between SPA revoke calls. */
  googleBrowserBinding?: CalendarGoogleBrowserBinding;
}

// Classify every field so adding a connection field requires an explicit cache-policy decision.
// Bookkeeping may lag in an explicitly stale response; policy/identity transitions must not.
const CONNECTION_CACHE_FIELDS = {
  tenant: "scope",
  subject: "policy",
  state: "policy",
  generation: "policy",
  errorCode: "policy",
  offReason: "policy",
  consentAt: "bookkeeping",
  scopes: "bookkeeping",
  credentialRef: "bookkeeping",
  nextScanAt: "bookkeeping",
  lastScanAt: "bookkeeping",
  lastDispatchLag: "bookkeeping",
  scanComplete: "bookkeeping",
  setupId: "bookkeeping",
  setupExpiresAt: "bookkeeping",
  verifiedEmail: "bookkeeping",
  googleBrowserBinding: "bookkeeping",
} satisfies Record<keyof CalendarConnection, "scope" | "policy" | "bookkeeping">;

function connectionPolicyChanged(previous: CalendarConnection | null, next: CalendarConnection): boolean {
  return (Object.keys(CONNECTION_CACHE_FIELDS) as (keyof CalendarConnection)[])
    .some(field => CONNECTION_CACHE_FIELDS[field] === "policy" && previous?.[field] !== next[field]);
}

/** One tenant's intent to capture a Meet URL during a window (TC-581). Never holds a meeting id. */
export interface CaptureClaim { tenant: string; occurrenceId: string; start: number; end: number; updatedAt: number }

/**
 * Set on a recipient occurrence that attached to another tenant's live capture instead of sending
 * its own bot. The owner's meeting id is always read from the owner's own occurrence row.
 */
export interface SharedCapture {
  ownerTenant: string;
  ownerOccurrenceId: string;
  attachedAt: number;
  /** True only when the capturing account is on the attaching account's OWN invite. Anything else is unverified. */
  corroborated?: boolean;
  checkedAt?: number;
  result?: "shared" | "not_shared";
  reason?: string;
}

export type CalendarOccurrencePhase = "pending" | "outcome_unknown" | "ownership_pending" | "sent" | "stop_pending" | "terminal";
export interface CalendarOccurrence {
  id: string;
  tenant: string;
  subject: string;
  eventId: string;
  start: number;
  end: number;
  meetingUrl: string;
  title: string;
  phase: CalendarOccurrencePhase;
  nextAttemptAt: number;
  attemptCount: number;
  generation?: number;
  createBody?: CreateMeetingInput;
  requestHash?: string;
  idempotencyKey?: string;
  meetingId?: string;
  stopRequested: boolean;
  errorCode?: string;
  disposition?: string;
  /** TC-907: the latest create was refused with 429 `capacity_exhausted`, so it created nothing. */
  capacityExhausted?: boolean;
  /** Never put the owner's meeting id in `meetingId`: getStatus returns that to the browser. */
  sharedCapture?: SharedCapture;
  /** TC-988: first observation, preserved on rescans. Legacy rows may omit this. */
  firstSeenAt?: number;
  updatedAt: number;
}

/** Intentionally never expires, including after a user deletes the recording. */
export interface CalendarSentMarker {
  tenant: string;
  id: string;
  meetingId?: string;
  disposition: string;
}
type Update<T> = (current: T | null) => T | null;
/** Attempted status reads/listings, including a read that fails or cannot enter the lane. */
export interface CalendarAutojoinReadMetrics { reads: number }
/** Reads that take `deadline` (epoch ms) reject once it passes instead of queueing further. */
export interface CalendarAutojoinStore {
  readonly statusCache: CalendarAutojoinStatusCache;
  getConnection(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<CalendarConnection | null>;
  putConnection(row: CalendarConnection): Promise<void>;
  updateConnection(tenant: string, update: Update<CalendarConnection>): Promise<CalendarConnection | null>;
  listConnections(): Promise<CalendarConnection[]>;
  getStatusSummary(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<CalendarAutojoinStatusSummary | null>;
  getStatusSummaryOrLegacy(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<CalendarAutojoinStatusSummary>;
  putStatusSummary(tenant: string, summary: CalendarAutojoinStatusSummary): Promise<void>;
  forgetStatusSummaryDigest(tenant: string): void;
  getOccurrence(tenant: string, id: string): Promise<CalendarOccurrence | null>;
  putOccurrence(row: CalendarOccurrence): Promise<void>;
  updateOccurrence(tenant: string, id: string, update: Update<CalendarOccurrence>): Promise<CalendarOccurrence | null>;
  listOccurrences(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<CalendarOccurrence[]>;
  deleteOccurrence(tenant: string, id: string): Promise<void>;
  getMarker(tenant: string, id: string): Promise<CalendarSentMarker | null>;
  putMarker(row: CalendarSentMarker): Promise<void>;
  getCaptureClaims(meetingUrl: string): Promise<CaptureClaim[]>;
  /** Claims whose window ended more than 24h before `now` are pruned on every write. */
  updateCaptureClaims(meetingUrl: string, update: (claims: CaptureClaim[]) => CaptureClaim[], now?: number): Promise<CaptureClaim[]>;
}

/** Same-process policy lock. Never hold the global storage lane across network I/O. */
export class TenantCoordinator {
  private readonly lanes = new Map<string, Promise<unknown>>();
  run<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    const key = tenant.toLowerCase();
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    this.lanes.set(key, settled);
    void settled.then(() => { if (this.lanes.get(key) === settled) this.lanes.delete(key); });
    return next;
  }
}

interface JsonStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}
const PREFIX = "calendar-autojoin/v1/";
const tenantKey = (tenant: string) => createHash("sha256").update(tenant.toLowerCase()).digest("hex");
const connectionKey = (tenant: string) => `${PREFIX}connections/${tenantKey(tenant)}`;
const statusKey = (tenant: string) => `${PREFIX}status/${tenantKey(tenant)}`;
const occurrencePrefix = (tenant: string) => `${PREFIX}occurrences/${tenantKey(tenant)}/`;
const markerKey = (tenant: string, id: string) => `${PREFIX}sent/${tenantKey(tenant)}/${id}`;
const captureKey = (meetingUrl: string) =>
  `${PREFIX}captures/${createHash("sha256").update(normalizeGoogleMeetUrl(meetingUrl) ?? meetingUrl).digest("hex")}`;
const CLAIM_RETENTION_MS = 86_400_000;
// The three stores already share a cache identity. Keep committed summary digests coherent across
// worker publication and user teardown without extra KV reads, with the same bounded tenant cap.
const summaryWriteDigests = new WeakMap<CalendarAutojoinStatusCache, Map<string, string>>();
/** An unreadable projection can be rebuilt; authoritative connection corruption cannot. */
class CalendarAutojoinSummaryInvalid extends Error {
  constructor() { super("calendar_status_summary_invalid"); }
}

class JsonCalendarAutojoinStore implements CalendarAutojoinStore {
  private readonly summaryDigests: Map<string, string>;
  constructor(
    private readonly json: JsonStore,
    private readonly lane: BackendStorageLane,
    private readonly laneOptions: BackendStorageLaneRunOptions = {},
    readonly statusCache = new CalendarAutojoinStatusCache(),
  ) {
    this.summaryDigests = summaryWriteDigests.get(statusCache) ?? new Map();
    summaryWriteDigests.set(statusCache, this.summaryDigests);
  }
  getConnection(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics) { return this.read(() => this.json.get<CalendarConnection>(connectionKey(tenant)), deadline, metrics); }
  putConnection(row: CalendarConnection) { return this.updateConnection(row.tenant, () => row).then(() => undefined); }
  updateConnection(tenant: string, fn: Update<CalendarConnection>) {
    // Compare and persist in the same serialized lane job, against the actual previous row.
    return this.run(async () => {
      const key = connectionKey(tenant);
      const previous = await this.json.get<CalendarConnection>(key);
      const next = fn(previous === null ? null : structuredClone(previous));
      if (next !== null) {
        const write = async () => {
          await this.json.put(key, next);
          // Connection rows are never deleted; a new tenant cannot have occurrence history.
          if (previous === null) {
            try { await this.writeSummary(tenant, { version: 1, outcomes: [] }); }
            catch { this.forgetStatusSummaryDigest(tenant); }
          }
        };
        if (connectionPolicyChanged(previous, next)) await this.statusCache.mutate(tenant, write);
        else await write();
      }
      return next;
    });
  }
  listConnections() { return this.list<CalendarConnection>(`${PREFIX}connections/`); }
  getStatusSummary(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics) {
    return this.read(() => this.readSummary(tenant), deadline, metrics);
  }
  async getStatusSummaryOrLegacy(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics) {
    const summaryOrKeys = await this.read(async () => {
      const summary = await this.readSummary(tenant);
      if (summary) return summary;
      // Share the summary probe's lane job with the legacy prefix lookup: the complete status
      // path remains N+2 jobs, with each occurrence read yielding as before. The probe adds one
      // KV call on this migration path; don't start the lookup after the request's deadline.
      if (deadline !== undefined && Date.now() >= deadline) throw new BackendStorageLaneTimeout("request deadline passed before the legacy listing");
      return this.json.keys(occurrencePrefix(tenant));
    }, deadline, metrics);
    if (!Array.isArray(summaryOrKeys)) return summaryOrKeys;
    const rows = await this.listKeys<CalendarOccurrence>(summaryOrKeys, deadline, metrics);
    return { version: 1 as const, outcomes: calendarAutojoinOutcomes(rows) };
  }
  /** Only called inside a lane job. Missing/invalid projections use the authoritative listing. */
  private async readSummary(tenant: string) {
    try {
      const summary = await this.json.get<CalendarAutojoinStatusSummary>(statusKey(tenant));
      if (summary === null) { this.forgetStatusSummaryDigest(tenant); return null; }
      if (typeof summary !== "object" || summary.version !== 1 || !Array.isArray(summary.outcomes) || summary.outcomes.length > 30
        || !summary.outcomes.every(row => row && typeof row.id === "string" && typeof row.reason === "string"
          && typeof row.start === "number" && Number.isFinite(row.start)
          && (row.title === undefined || typeof row.title === "string")
          && (row.meetingId === undefined || typeof row.meetingId === "string"))) {
        throw new CalendarAutojoinSummaryInvalid();
      }
      return summary;
    } catch (error) {
      // The JSON store also reports malformed projection JSON/envelopes through these errors.
      // Scope their recovery to this key; connection/listing corruption keeps its old behavior.
      if (!(error instanceof CalendarAutojoinSummaryInvalid || error instanceof SyntaxError
        || (error instanceof Error && error.message === "calendar_state_invalid"))) throw error;
      this.forgetStatusSummaryDigest(tenant);
      return null;
    }
  }
  forgetStatusSummaryDigest(tenant: string): void { this.summaryDigests.delete(tenant.toLowerCase()); }
  putStatusSummary(tenant: string, summary: CalendarAutojoinStatusSummary) {
    const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
    if (this.summaryDigests.get(tenant.toLowerCase()) === digest) {
      this.rememberSummaryDigest(tenant, digest);
      return Promise.resolve();
    }
    return this.run(() => this.writeSummary(tenant, summary, digest));
  }
  /** Only called inside a lane job; remembered digests describe committed writes. */
  private async writeSummary(tenant: string, summary: CalendarAutojoinStatusSummary,
    digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex")): Promise<void> {
    if (this.summaryDigests.get(tenant.toLowerCase()) !== digest) await this.json.put(statusKey(tenant), summary);
    this.rememberSummaryDigest(tenant, digest);
  }
  private rememberSummaryDigest(tenant: string, digest: string): void {
    const key = tenant.toLowerCase();
    this.summaryDigests.delete(key);
    this.summaryDigests.set(key, digest);
    if (this.summaryDigests.size > STATUS_CACHE_MAX_TENANTS) this.summaryDigests.delete(this.summaryDigests.keys().next().value!);
  }
  getOccurrence(tenant: string, id: string) { return this.run(() => this.json.get<CalendarOccurrence>(occurrencePrefix(tenant) + id)); }
  putOccurrence(row: CalendarOccurrence) { return this.run(() => this.json.put(occurrencePrefix(row.tenant) + row.id, row)); }
  updateOccurrence(tenant: string, id: string, fn: Update<CalendarOccurrence>) { return this.update(occurrencePrefix(tenant) + id, fn); }
  listOccurrences(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics) { return this.list<CalendarOccurrence>(occurrencePrefix(tenant), deadline, metrics); }
  deleteOccurrence(tenant: string, id: string) { return this.run(() => this.json.remove(occurrencePrefix(tenant) + id)); }
  getMarker(tenant: string, id: string) { return this.run(() => this.json.get<CalendarSentMarker>(markerKey(tenant, id))); }
  putMarker(row: CalendarSentMarker) { return this.run(() => this.json.put(markerKey(row.tenant, row.id), row)); }
  async getCaptureClaims(meetingUrl: string) {
    return (await this.run(() => this.json.get<{ claims?: CaptureClaim[] }>(captureKey(meetingUrl))))?.claims ?? [];
  }
  async updateCaptureClaims(meetingUrl: string, fn: (claims: CaptureClaim[]) => CaptureClaim[], now = Date.now()) {
    const doc = await this.update<{ claims: CaptureClaim[] }>(captureKey(meetingUrl), current => ({
      claims: fn(current?.claims ?? []).filter(claim => claim.end >= now - CLAIM_RETENTION_MS),
    }));
    return doc!.claims;
  }
  /** With a deadline, or the store's wait budget, a read only waits for the time remaining. */
  private run<T>(fn: () => Promise<T>, deadline = this.defaultDeadline()): Promise<T> {
    if (deadline === undefined) return this.lane.run(fn, this.laneOptions);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new BackendStorageLaneTimeout("request deadline passed before the next lane read"));
    return this.lane.run(fn, { ...this.laneOptions, waitTimeoutMs: remaining });
  }
  private read<T>(fn: () => Promise<T>, deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<T> {
    if (metrics) metrics.reads++;
    return this.run(fn, deadline);
  }
  private defaultDeadline(): number | undefined {
    const budget = this.laneOptions.waitTimeoutMs;
    return budget === undefined ? undefined : Date.now() + budget;
  }
  private update<T>(key: string, fn: Update<T>): Promise<T | null> {
    return this.run(async () => {
      const next = fn(await this.json.get<T>(key));
      if (next !== null) await this.json.put(key, next);
      return next;
    });
  }
  /** One lane slot per key, so other lane users interleave with a long listing. A key removed
   * between the listing and its read is skipped. An explicit deadline covers the whole listing
   * (getStatus). Without one, each slot gets the store's wait budget on its own, like any single
   * read: write flows that list inside them (disableLocked) must not fail partway on a tenant with
   * many rows. */
  private async list<T>(prefix: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<T[]> {
    const keys = await this.read(() => this.json.keys(prefix), deadline, metrics);
    return this.listKeys<T>(keys, deadline, metrics);
  }
  private async listKeys<T>(keys: string[], deadline?: number, metrics?: CalendarAutojoinReadMetrics): Promise<T[]> {
    const rows: T[] = [];
    for (const key of keys) {
      const row = await this.read(() => this.json.get<T>(key), deadline, metrics);
      if (row) rows.push(row);
    }
    return rows;
  }
}

export class MemoryCalendarAutojoinStore extends JsonCalendarAutojoinStore {
  constructor(statusCache = new CalendarAutojoinStatusCache()) {
    const rows = new Map<string, unknown>();
    super({
      async get<T>(key: string) { return structuredClone(rows.get(key) ?? null) as T | null; },
      async put(key, row) { rows.set(key, structuredClone(row)); },
      async remove(key) { rows.delete(key); },
      async keys(prefix) { return [...rows.keys()].filter(key => key.startsWith(prefix)); },
    }, new BackendStorageLane(), {}, statusCache);
  }
}

export class KvCalendarAutojoinStore extends JsonCalendarAutojoinStore {
  constructor(node: TinyCloudNode, lane: BackendStorageLane, laneOptions: BackendStorageLaneRunOptions = {}, statusCache = new CalendarAutojoinStatusCache()) {
    super({
      async get<T>(key: string) {
        const result = await withSessionRefresh(node, async () => {
          const response = await node.kv.get(key);
          return isKvMissingKeyResult(response, key) ? null : assertKvResult(response);
        });
        if (result === null) return null;
        const outer = (result as { data?: unknown }).data;
        const raw = (outer as { data?: unknown } | null)?.data ?? outer;
        if (raw === null || raw === undefined) throw new Error("calendar_state_invalid");
        return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
      },
      async put(key, row) { await withSessionRefresh(node, async () => assertKvResult(await node.kv.put(key, row))); },
      async remove(key) {
        await withSessionRefresh(node, async () => {
          const response = await node.kv.delete(key);
          if (!isKvMissingKeyResult(response, key)) assertKvResult(response);
        });
      },
      async keys(prefix) {
        const result = await withSessionRefresh(node, async () => assertKvResult(await node.kv.list({ prefix })));
        const data = (result as { data?: { keys?: unknown } }).data;
        if (!Array.isArray(data?.keys) || !data.keys.every(key => typeof key === "string")) {
          throw new Error("calendar_listing_invalid");
        }
        return data.keys.map(key => key.startsWith(prefix) ? key : `${prefix}${key}`);
      },
    }, lane, laneOptions, statusCache);
  }
}

/**
 * Same lane, three priorities. Request handlers (status/enable/disable) queue ahead of the
 * reconcile worker and give up before the client's 20 s abort; the worker's scans and listings
 * yield to them. TC-1047: the dispatch path of one due occurrence (its reads, capture claims, the
 * intent write and the post-send writes) queues with requests, but with no wait budget: no client
 * waits on it, and under contention it must be late rather than fail and retry, which would add
 * more lane work. A storage failure before the intent write still sends nothing and is retried.
 */
export function kvCalendarAutojoinStores(node: TinyCloudNode, lane: BackendStorageLane) {
  const statusCache = new CalendarAutojoinStatusCache();
  return {
    request: new KvCalendarAutojoinStore(node, lane, { waitTimeoutMs: REQUEST_LANE_WAIT_MS }, statusCache),
    worker: new KvCalendarAutojoinStore(node, lane, { priority: "background" }, statusCache),
    dispatch: new KvCalendarAutojoinStore(node, lane, { priority: "foreground" }, statusCache),
  };
}
