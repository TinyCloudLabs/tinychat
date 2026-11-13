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
  /** `rebuild`: a compare-and-set. The row written is `rebuild(stored)`, built on the stored row and
   *  written with If-Match on its ETag; null refuses, rejecting with CalendarRowChanged. Without it,
   *  `row` is written (still If-Match on the version read). */
  putConnection(row: CalendarConnection, rebuild?: (stored: CalendarConnection | null) => CalendarConnection | null): Promise<void>;
  updateConnection(tenant: string, update: Update<CalendarConnection>): Promise<CalendarConnection | null>;
  /** The connection as the node stores it, even through the worker's cached store. Consent checks
   *  that gate a Google read or a running recording use this. */
  getConnectionFresh(tenant: string): Promise<CalendarConnection | null>;
  listConnections(): Promise<CalendarConnection[]>;
  /** The next read of each connection row goes to the node; scan times staged in memory survive it. */
  rereadConnections(): void;
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

/** A row as the node stores it, with the node's ETag when it sends one. */
interface StoredRow<T> { value: T; etag?: string }
/** A write's precondition: the node still holds the version `ifMatch` names, or holds no row. */
type WriteCondition = { ifMatch: string } | { ifNoneMatch: "*" };
/** A conditional write found the row changed on the node since it was read. */
export class CalendarRowChanged extends Error {
  constructor() { super("calendar_row_changed"); }
}
interface JsonStore {
  get<T>(key: string): Promise<T | null>;
  /** Always from the node, with its ETag. On the worker's cached store a staged value survives only
   *  when the node still holds the copy it was staged on. */
  read<T>(key: string): Promise<StoredRow<T> | null>;
  /** Resolves to the written row's ETag when the node sends one; rejects with CalendarRowChanged
   *  when `condition` no longer holds. */
  put(key: string, value: unknown, condition?: WriteCondition): Promise<string | undefined>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  /** True when `get` may answer from memory (the worker's cached store). */
  readonly servesMemory?: boolean;
  /** Cached stores only: the row's live value changes in memory; the node keeps its stored copy.
   *  False when the row is not in memory (evicted): the caller writes it instead. */
  stage?(key: string, value: unknown): boolean;
  /** Cached stores only: the next read of each row under `prefix` goes to the node. A staged value
   *  survives when the node still holds its stored copy. Listings stay: writes keep them complete. */
  rereadRows?(prefix: string): void;
}
/** Key-order independent JSON, so an unchanged row compares equal however it was built. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => field && typeof field === "object" && !Array.isArray(field)
    ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : field);
}
/** A conditional write that keeps finding the row changed gives up after this many reads. */
const CONNECTION_WRITE_ATTEMPTS = 3;
let unconditionalWriteLogged = false;
/** The production node sends an ETag with every KV read. Without one (an older node, or a test
 *  double) a connection write cannot be conditional: say so once rather than silently. */
function logUnconditionalConnectionWrite(): void {
  if (unconditionalWriteLogged) return;
  unconditionalWriteLogged = true;
  console.warn("[calendar-autojoin] code=connection_write_unconditional reason=no_etag");
}
/** Fields every scan rewrites. Alone, they reach the node once per hour (see updateConnection). */
const SCAN_BOOKKEEPING_PERSIST_MS = 3_600_000;
function scanBookkeepingOnly(previous: CalendarConnection, next: CalendarConnection): boolean {
  const hour = (row: CalendarConnection) => Math.floor((row.lastScanAt ?? 0) / SCAN_BOOKKEEPING_PERSIST_MS);
  const rest = (row: CalendarConnection) => stableJson({ ...row, lastScanAt: undefined, nextScanAt: undefined });
  return hour(previous) === hour(next) && rest(previous) === rest(next);
}

interface CachedRow { value: unknown; persisted: string; etag?: string; stale?: boolean }
/** Default bounds of the row cache: about 1 KiB per row. */
const ROW_CACHE_MAX_ROWS = 20_000;
const ROW_CACHE_MAX_LISTINGS = 5_000;
/**
 * In-process copy of the calendar rows, shared by the request, worker and dispatch stores. The
 * status projection is not cached: only status requests read it.
 *
 * Only the worker store reads from memory, and only where a stale answer cannot act on consent:
 * every durable connection write re-reads the node first (updateConnection), and the worker reads
 * the connection from the node before each Google scan, each recording and sharing check, and each
 * dispatch. Writing the value the node already stores is skipped. Durable writes come first: memory
 * changes after the node acknowledges a write, and a failed write (its outcome unknown) forgets the
 * row (a stale placeholder) and lists the key as possibly present, so the next read goes to the node. Every call runs inside
 * a storage lane job, so read-compare-write stays serialized. A restart starts empty.
 *
 * Absence is known only from a listing (no tombstones): a worker read of a key no listing covers
 * lists its directory once. Rows and listings are bounded, least recently used first out; an evicted
 * row is read from the node again (an evicted staged scan time only makes the next scan early).
 */
export class CalendarAutojoinRowCache {
  /** Insertion order is recency: every hit re-inserts. */
  private readonly rows = new Map<string, CachedRow>();
  /** Complete key sets of listed prefixes, same recency order. */
  private readonly listings = new Map<string, Set<string>>();
  private readonly maxRows: number;
  private readonly maxListings: number;

  constructor(bounds: { maxRows?: number; maxListings?: number } = {}) {
    this.maxRows = bounds.maxRows ?? ROW_CACHE_MAX_ROWS;
    this.maxListings = bounds.maxListings ?? ROW_CACHE_MAX_LISTINGS;
  }

  /** `json` read through this cache. `freshReads` stores (request and dispatch) read every row and
   *  listing from the node, and keep the cache current with what they read. */
  view(json: JsonStore, freshReads = false): JsonStore {
    const cached = (key: string) => !key.startsWith(`${PREFIX}status/`);
    const fresh = async <T>(key: string) => this.observe(key, await json.read<T>(key));
    const keys = async (prefix: string) => {
      const listing = freshReads ? undefined : this.touch(this.listings, prefix);
      if (listing) return [...listing];
      const listed = await json.keys(prefix);
      if (!cached(prefix)) return listed;
      const present = new Set(listed);
      for (const key of this.rows.keys()) if (key.startsWith(prefix) && !present.has(key)) this.rows.delete(key);
      this.remember(this.listings, prefix, present, this.maxListings);
      return listed;
    };
    return {
      servesMemory: !freshReads,
      get: async <T>(key: string) => {
        if (!cached(key)) return json.get<T>(key);
        if (freshReads) return (await fresh<T>(key))?.value ?? null;
        const known = this.touch(this.rows, key);
        if (known && !known.stale) return structuredClone(known.value) as T;
        if (!known) {
          let covered = this.covering(key);
          if (!covered) { await keys(key.slice(0, key.lastIndexOf("/") + 1)); covered = this.covering(key); }
          if (covered && !covered.has(key)) return null;
        }
        return (await fresh<T>(key))?.value ?? null;
      },
      read: async <T>(key: string) => cached(key) ? fresh<T>(key) : json.read<T>(key),
      put: async (key, value, explicit) => {
        if (!cached(key)) return json.put(key, value, explicit);
        const persisted = stableJson(value);
        const known = this.rows.get(key);
        // Every write is conditional on the version memory last saw: If-Match on its ETag, or
        // If-None-Match where a listing says the key is absent. A row changed on the node since
        // rejects (CalendarRowChanged) and is read again by the caller's retry.
        const covered = known ? undefined : this.covering(key);
        const condition: WriteCondition | undefined = explicit
          ?? (known?.etag !== undefined && !known.stale ? { ifMatch: known.etag }
            : covered && !covered.has(key) ? { ifNoneMatch: "*" } : undefined);
        // Nothing to write when the node holds this value: as memory last saw it, or at the very
        // version the condition names.
        const unchanged = !!known && !known.stale && known.persisted === persisted
          && (condition === undefined || ("ifMatch" in condition && known.etag === condition.ifMatch));
        let etag = known?.etag;
        if (!unchanged) {
          try { etag = await json.put(key, value, condition); }
          catch (error) { this.forget(key); throw error; }
        }
        this.remember(this.rows, key, { value: structuredClone(value), persisted, etag }, this.maxRows);
        this.listed(key, true);
        return etag;
      },
      remove: async key => {
        if (!cached(key)) return json.remove(key);
        const covered = this.covering(key);
        if (!this.rows.has(key) && covered && !covered.has(key)) return;
        try { await json.remove(key); }
        catch (error) { this.forget(key); throw error; }
        this.rows.delete(key);
        this.listed(key, false);
      },
      keys,
      stage: (key, value) => {
        const known = this.rows.get(key);
        if (!known || known.stale) return false;
        this.rows.set(key, { value: structuredClone(value), persisted: known.persisted, etag: known.etag });
        return true;
      },
      rereadRows: prefix => {
        for (const [key, row] of this.rows) if (key.startsWith(prefix)) row.stale = true;
      },
    };
  }
  /** A node read. When it matches the stored copy, memory keeps any newer staged value. */
  private observe<T>(key: string, stored: StoredRow<T> | null): StoredRow<T> | null {
    const known = this.rows.get(key);
    if (stored === null) { this.rows.delete(key); this.listed(key, false); return null; }
    const persisted = stableJson(stored.value);
    const { etag } = stored;
    if (known?.persisted === persisted) {
      this.remember(this.rows, key, { value: known.value, persisted, etag }, this.maxRows);
      return { value: structuredClone(known.value) as T, etag };
    }
    this.remember(this.rows, key, { value: structuredClone(stored.value), persisted, etag }, this.maxRows);
    this.listed(key, true);
    return stored;
  }
  private touch<V>(map: Map<string, V>, key: string): V | undefined {
    const value = map.get(key);
    if (value !== undefined) { map.delete(key); map.set(key, value); }
    return value;
  }
  private remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value!);
  }
  /** The listing that says whether `key` exists, if any. */
  private covering(key: string): Set<string> | undefined {
    for (const [prefix, keys] of this.listings) if (key.startsWith(prefix)) return keys;
    return undefined;
  }
  private listed(key: string, present: boolean): void {
    for (const [prefix, keys] of this.listings) {
      if (!key.startsWith(prefix)) continue;
      if (present) keys.add(key); else keys.delete(key);
    }
  }
  /** A failed write: the row's value, and whether it exists, are unknown. A stale placeholder sends
   *  the next read and write to the node; listing it keeps the listings complete. */
  private forget(key: string): void {
    this.remember(this.rows, key, { value: null, persisted: "", stale: true }, this.maxRows);
    this.listed(key, true);
  }
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
  async putConnection(row: CalendarConnection, rebuild?: (stored: CalendarConnection | null) => CalendarConnection | null) {
    const written = await this.updateConnection(row.tenant, stored => rebuild ? rebuild(stored) : row);
    if (written === null) throw new CalendarRowChanged();
  }
  updateConnection(tenant: string, fn: Update<CalendarConnection>) {
    return this.run(async () => {
      const key = connectionKey(tenant);
      if (this.json.servesMemory) {
        // The live lastScanAt/nextScanAt stay in memory; the node's copy lags by at most an hour. A
        // restart reads an overdue nextScanAt, which only scans at once.
        const cached = await this.json.get<CalendarConnection>(key);
        const staged = fn(cached === null ? null : structuredClone(cached));
        if (staged !== null && cached !== null && scanBookkeepingOnly(cached, staged) && this.json.stage?.(key, staged)) return staged;
      }
      // Every durable write is a compare-and-set on the node: read the stored row and its ETag, run
      // the update on that row, and write only while the node still holds that version (If-Match;
      // If-None-Match for a new row). Memory's policy fields never reach the node, and a disable, a
      // new generation or a deletion stored in between is read again and decided on.
      for (let attempt = 1; ; attempt++) {
        const stored = await this.json.read<CalendarConnection>(key);
        const previous = stored?.value ?? null;
        const next = fn(previous === null ? null : structuredClone(previous));
        if (next === null) return null;
        let condition: WriteCondition | undefined = { ifNoneMatch: "*" };
        if (stored) {
          condition = stored.etag === undefined ? undefined : { ifMatch: stored.etag };
          if (!condition) logUnconditionalConnectionWrite();
        }
        const write = async () => {
          await this.json.put(key, next, condition);
          // A new tenant cannot have occurrence history.
          if (previous === null) {
            try { await this.writeSummary(tenant, { version: 1, outcomes: [] }); }
            catch { this.forgetStatusSummaryDigest(tenant); }
          }
        };
        try {
          if (connectionPolicyChanged(previous, next)) await this.statusCache.mutate(tenant, write);
          else await write();
          return next;
        } catch (error) {
          if (!(error instanceof CalendarRowChanged) || attempt >= CONNECTION_WRITE_ATTEMPTS) throw error;
        }
      }
    });
  }
  getConnectionFresh(tenant: string) {
    const key = connectionKey(tenant);
    return this.read(async () => (await this.json.read<CalendarConnection>(key))?.value ?? null);
  }
  listConnections() { return this.list<CalendarConnection>(`${PREFIX}connections/`); }
  rereadConnections(): void { this.json.rereadRows?.(`${PREFIX}connections/`); }
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
  putOccurrence(row: CalendarOccurrence) { return this.run(async () => { await this.json.put(occurrencePrefix(row.tenant) + row.id, row); }); }
  updateOccurrence(tenant: string, id: string, fn: Update<CalendarOccurrence>) { return this.update(occurrencePrefix(tenant) + id, fn); }
  listOccurrences(tenant: string, deadline?: number, metrics?: CalendarAutojoinReadMetrics) { return this.list<CalendarOccurrence>(occurrencePrefix(tenant), deadline, metrics); }
  deleteOccurrence(tenant: string, id: string) { return this.run(() => this.json.remove(occurrencePrefix(tenant) + id)); }
  getMarker(tenant: string, id: string) { return this.run(() => this.json.get<CalendarSentMarker>(markerKey(tenant, id))); }
  putMarker(row: CalendarSentMarker) { return this.run(async () => { await this.json.put(markerKey(row.tenant, row.id), row); }); }
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
  /** Read, update and write conditionally (see the cache's put); a row changed on the node since it
   *  was read is read again and the update re-run on it. */
  private update<T>(key: string, fn: Update<T>): Promise<T | null> {
    return this.run(async () => {
      for (let attempt = 1; ; attempt++) {
        const next = fn(await this.json.get<T>(key));
        if (next === null) return next;
        try { await this.json.put(key, next); return next; }
        catch (error) { if (!(error instanceof CalendarRowChanged) || attempt >= CONNECTION_WRITE_ATTEMPTS) throw error; }
      }
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
    const rows = new Map<string, { value: unknown; version: number }>();
    let versions = 0;
    super({
      async get<T>(key: string) { return structuredClone(rows.get(key)?.value ?? null) as T | null; },
      async read<T>(key: string) {
        const row = rows.get(key);
        return row ? { value: structuredClone(row.value) as T, etag: `"v${row.version}"` } : null;
      },
      async put(key, value, condition) {
        const current = rows.get(key);
        if (condition && ("ifNoneMatch" in condition ? current : `"v${current?.version}"` !== condition.ifMatch)) throw new CalendarRowChanged();
        const version = ++versions;
        rows.set(key, { value: structuredClone(value), version });
        return `"v${version}"`;
      },
      async remove(key) { rows.delete(key); },
      async keys(prefix) { return [...rows.keys()].filter(key => key.startsWith(prefix)); },
    }, new BackendStorageLane(), {}, statusCache);
  }
}

/** The node's answer to a write whose If-Match/If-None-Match no longer holds (HTTP 412). */
function isKvPreconditionFailure(response: unknown): boolean {
  if (response === null || typeof response !== "object" || !("ok" in response) || response.ok !== false) return false;
  const error = "error" in response ? response.error : undefined;
  return error !== null && typeof error === "object" && "code" in error && error.code === "KV_PRECONDITION_FAILED";
}

/** `rows`: read through a row cache shared with the process's other calendar stores. */
export class KvCalendarAutojoinStore extends JsonCalendarAutojoinStore {
  constructor(node: TinyCloudNode, lane: BackendStorageLane, laneOptions: BackendStorageLaneRunOptions = {}, statusCache = new CalendarAutojoinStatusCache(),
    rows?: { cache: CalendarAutojoinRowCache; freshReads?: boolean }) {
    const read = async <T>(key: string): Promise<StoredRow<T> | null> => {
      const result = await withSessionRefresh(node, async () => {
        const response = await node.kv.get(key);
        return isKvMissingKeyResult(response, key) ? null : assertKvResult(response);
      });
      if (result === null) return null;
      const outer = (result as { data?: unknown }).data;
      const raw = (outer as { data?: unknown } | null)?.data ?? outer;
      if (raw === null || raw === undefined) throw new Error("calendar_state_invalid");
      const etag = (outer as { headers?: { etag?: unknown } } | null)?.headers?.etag;
      return { value: (typeof raw === "string" ? JSON.parse(raw) : raw) as T, etag: typeof etag === "string" ? etag : undefined };
    };
    const json: JsonStore = {
      async get<T>(key: string) { return (await read<T>(key))?.value ?? null; },
      read,
      async put(key, row, condition) {
        return withSessionRefresh(node, async () => {
          const response = await node.kv.put(key, row, condition);
          if (isKvPreconditionFailure(response)) throw new CalendarRowChanged();
          const etag = (assertKvResult(response) as { data?: { headers?: { etag?: unknown } } }).data?.headers?.etag;
          return typeof etag === "string" ? etag : undefined;
        });
      },
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
    };
    super(rows ? rows.cache.view(json, rows.freshReads) : json, lane, laneOptions, statusCache);
  }
}

/**
 * Same lane, three priorities. Request handlers (status/enable/disable) queue ahead of the
 * reconcile worker and give up before the client's 20 s abort; the worker's scans and listings
 * yield to them. TC-1047: the dispatch path of one due occurrence (its reads, capture claims, the
 * intent write and the post-send writes) queues with requests, but with no wait budget: no client
 * waits on it, and under contention it must be late rather than fail and retry, which would add
 * more lane work. A storage failure before the intent write still sends nothing and is retried.
 *
 * One row cache serves all three. Only the worker store reads from it: request handlers and the
 * dispatch path read every row from the node, so user actions and the policy checks that decide a
 * POST see the stored connection and occurrence, never memory alone.
 */
export function kvCalendarAutojoinStores(node: TinyCloudNode, lane: BackendStorageLane) {
  const statusCache = new CalendarAutojoinStatusCache();
  const cache = new CalendarAutojoinRowCache();
  return {
    request: new KvCalendarAutojoinStore(node, lane, { waitTimeoutMs: REQUEST_LANE_WAIT_MS }, statusCache, { cache, freshReads: true }),
    worker: new KvCalendarAutojoinStore(node, lane, { priority: "background" }, statusCache, { cache }),
    dispatch: new KvCalendarAutojoinStore(node, lane, { priority: "foreground" }, statusCache, { cache, freshReads: true }),
  };
}
