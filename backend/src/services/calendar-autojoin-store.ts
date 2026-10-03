import { createHash } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import { BackendStorageLane } from "./backend-storage-lane.js";
import type { CreateMeetingInput } from "./transcription-api.js";

export interface CalendarConnection {
  tenant: string;
  subject: string | null;
  state: "disabled" | "enabling" | "enabled" | "needs_reconnect";
  generation: number;
  consentAt?: number;
  scopes: string[];
  credentialRef?: string;
  nextScanAt: number;
  lastScanAt?: number;
  errorCode?: string;
  scanComplete: boolean;
  setupId?: string;
  setupExpiresAt?: number;
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
export interface CalendarAutojoinStore {
  getConnection(tenant: string): Promise<CalendarConnection | null>;
  putConnection(row: CalendarConnection): Promise<void>;
  updateConnection(tenant: string, update: Update<CalendarConnection>): Promise<CalendarConnection | null>;
  listConnections(): Promise<CalendarConnection[]>;
  getOccurrence(tenant: string, id: string): Promise<CalendarOccurrence | null>;
  putOccurrence(row: CalendarOccurrence): Promise<void>;
  updateOccurrence(tenant: string, id: string, update: Update<CalendarOccurrence>): Promise<CalendarOccurrence | null>;
  listOccurrences(tenant: string): Promise<CalendarOccurrence[]>;
  deleteOccurrence(tenant: string, id: string): Promise<void>;
  getMarker(tenant: string, id: string): Promise<CalendarSentMarker | null>;
  putMarker(row: CalendarSentMarker): Promise<void>;
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
const occurrencePrefix = (tenant: string) => `${PREFIX}occurrences/${tenantKey(tenant)}/`;
const markerKey = (tenant: string, id: string) => `${PREFIX}sent/${tenantKey(tenant)}/${id}`;

class JsonCalendarAutojoinStore implements CalendarAutojoinStore {
  constructor(private readonly json: JsonStore, private readonly lane: BackendStorageLane) {}
  getConnection(tenant: string) { return this.lane.run(() => this.json.get<CalendarConnection>(connectionKey(tenant))); }
  putConnection(row: CalendarConnection) { return this.lane.run(() => this.json.put(connectionKey(row.tenant), row)); }
  updateConnection(tenant: string, fn: Update<CalendarConnection>) { return this.update(connectionKey(tenant), fn); }
  listConnections() { return this.list<CalendarConnection>(`${PREFIX}connections/`); }
  getOccurrence(tenant: string, id: string) { return this.lane.run(() => this.json.get<CalendarOccurrence>(occurrencePrefix(tenant) + id)); }
  putOccurrence(row: CalendarOccurrence) { return this.lane.run(() => this.json.put(occurrencePrefix(row.tenant) + row.id, row)); }
  updateOccurrence(tenant: string, id: string, fn: Update<CalendarOccurrence>) { return this.update(occurrencePrefix(tenant) + id, fn); }
  listOccurrences(tenant: string) { return this.list<CalendarOccurrence>(occurrencePrefix(tenant)); }
  deleteOccurrence(tenant: string, id: string) { return this.lane.run(() => this.json.remove(occurrencePrefix(tenant) + id)); }
  getMarker(tenant: string, id: string) { return this.lane.run(() => this.json.get<CalendarSentMarker>(markerKey(tenant, id))); }
  putMarker(row: CalendarSentMarker) { return this.lane.run(() => this.json.put(markerKey(row.tenant, row.id), row)); }
  private update<T>(key: string, fn: Update<T>): Promise<T | null> {
    return this.lane.run(async () => {
      const next = fn(await this.json.get<T>(key));
      if (next !== null) await this.json.put(key, next);
      return next;
    });
  }
  private list<T>(prefix: string): Promise<T[]> {
    return this.lane.run(async () => {
      const rows: T[] = [];
      for (const key of await this.json.keys(prefix)) {
        const row = await this.json.get<T>(key);
        if (row) rows.push(row);
      }
      return rows;
    });
  }
}

export class MemoryCalendarAutojoinStore extends JsonCalendarAutojoinStore {
  constructor() {
    const rows = new Map<string, unknown>();
    super({
      async get<T>(key: string) { return structuredClone(rows.get(key) ?? null) as T | null; },
      async put(key, row) { rows.set(key, structuredClone(row)); },
      async remove(key) { rows.delete(key); },
      async keys(prefix) { return [...rows.keys()].filter(key => key.startsWith(prefix)); },
    }, new BackendStorageLane());
  }
}

export class KvCalendarAutojoinStore extends JsonCalendarAutojoinStore {
  constructor(node: TinyCloudNode, lane: BackendStorageLane) {
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
    }, lane);
  }
}
