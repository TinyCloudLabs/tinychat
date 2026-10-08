import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/node-sdk/core";
import { normalizeTranscriberTranscript, transcriberMeetingInSpace, writeTranscriberMeeting } from "@tinyboilerplate/core";
import { DelegationCache, type DelegationStore } from "@tinyboilerplate/server";
import { evictStoredGrantVerification, parseStoredGrant, verificationCacheKey, type VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation } from "../portable-delegation.js";
import { BackendStorageLane } from "./backend-storage-lane.js";
import { TenantCoordinator } from "./calendar-autojoin-store.js";
import { ExternalOperationLimiter } from "./google-calendar.js";
import { resolvePendingCreates, KvJsonKv, type JsonKv, type TranscriberIndexStore } from "./transcriber-index.js";
import { TranscriptionApiError, type TranscriptionApiClient, type TranscriptionMeeting } from "./transcription-api.js";
import { delegatedConnectorPort } from "./user-space-port.js";

export type DeliveryOutcome = "written" | "existing" | "gone" | "owner_mismatch" | "cancelled";
export interface DeliveryState {
  v: 1;
  done: Record<string, { at: number; how: DeliveryOutcome }>;
  watch: Record<string, { since: number; nextAt: number; checks: number }>;
  retry: Record<string, { attempts: number; nextAt: number; code: string }>;
}
const emptyState = (): DeliveryState => ({ v: 1, done: {}, watch: {}, retry: {} });
const stateKey = (address: string) => `transcriber/delivery/${address.toLowerCase()}`;

/** Backend-owned KV; reads (including missing records) are cached for 60 seconds. */
export class KvTranscriptDeliveryStore {
  private readonly cache = new Map<string, { value: DeliveryState; until: number }>();
  private readonly json: JsonKv;
  constructor(node: TinyCloudNode | JsonKv, private readonly lane: BackendStorageLane = new BackendStorageLane(), json?: JsonKv) {
    this.json = json ?? ("kv" in node ? new KvJsonKv(node as TinyCloudNode) : node as JsonKv);
  }
  async read(address: string): Promise<DeliveryState> {
    address = address.toLowerCase();
    const entry = this.cache.get(address);
    if (entry && entry.until > Date.now()) {
      this.cache.delete(address); this.cache.set(address, entry);
      return entry.value;
    }
    const raw = await this.lane.run(() => this.json.get<DeliveryState>(stateKey(address)));
    const value = raw?.v === 1 ? {
      v: 1 as const,
      done: raw.done ?? {},
      watch: raw.watch ?? {},
      retry: raw.retry ?? {},
    } : emptyState();
    this.remember(address, value);
    return value;
  }
  stage(address: string, state: DeliveryState): void { this.remember(address.toLowerCase(), state); }
  async write(address: string, state: DeliveryState): Promise<void> {
    address = address.toLowerCase();
    await this.lane.run(() => this.json.put(stateKey(address), state));
    this.remember(address, state);
  }
  async hasSchemaMissing(address: string): Promise<boolean> {
    const state = await this.read(address);
    return Object.values(state.retry).some((entry) => entry.code === "schema_missing");
  }
  private remember(address: string, value: DeliveryState): void {
    this.cache.delete(address);
    this.cache.set(address, { value, until: Date.now() + 60_000 });
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
  }
}

/** One token is acquired immediately before each actual node write, outside any write lane. */
export class WriteGovernor {
  private tokens: number;
  private last: number;
  constructor(private readonly perMinute: number, private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
    if (!Number.isFinite(perMinute) || perMinute < 1) throw new Error("Write rate must be at least one per minute");
    this.tokens = Math.max(1, perMinute);
    this.last = now();
  }
  async take(): Promise<void> {
    const capacity = Math.max(1, this.perMinute);
    for (;;) {
      const now = this.now();
      this.tokens = Math.min(capacity, this.tokens + Math.max(0, now - this.last) * this.perMinute / 60_000);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await this.sleep(Math.ceil((1 - this.tokens) * 60_000 / this.perMinute));
    }
  }
}

type WakeKind = "completed" | "observed";
type Item = { address: string; id: string; kind?: WakeKind };
type SweepAction = Item | { kind: "intent" };
interface SweepCursor { addresses: string[]; ai: number; idOffset: number; pendingOffset: number; scanned: number; calls: number; }
export interface TranscriptDeliveryOptions {
  api: TranscriptionApiClient;
  index: TranscriberIndexStore;
  delegationStore: Pick<DelegationStore, "load" | "remove">;
  node: TinyCloudNode;
  backendDid: string;
  configuredHost: string;
  eligibility: (address: string) => boolean;
  coordinator?: TenantCoordinator;
  limiter?: ExternalOperationLimiter;
  governor?: WriteGovernor;
  storageLane?: BackendStorageLane;
  delegationCache?: DelegationCache;
  sweepMs?: number;
  runInWriteLane?: <T>(operation: () => Promise<T>) => Promise<T>;
  deliveryStore?: KvTranscriptDeliveryStore;
}

/** Single process writer. A webhook only admits an indexed id; the sweep is the durable queue. */
export class TranscriptDeliveryWorker {
  private readonly queue: Item[] = [];
  private readonly queued = new Set<string>();
  private readonly state: KvTranscriptDeliveryStore;
  private readonly coordinator: TenantCoordinator;
  private readonly limiter: ExternalOperationLimiter;
  private readonly governor: WriteGovernor;
  private readonly accessCache: DelegationCache;
  private readonly lookupApi: Pick<TranscriptionApiClient, "lookupMeetingByIdempotencyKey">;
  private readonly storageLane: BackendStorageLane;
  private readonly grants = new Map<string, { envelope: string | null; until: number }>();
  private readonly dirty = new Map<string, DeliveryState>();
  private readonly lastUpstream = new Map<string, number>();
  private readonly nextCheckAt = new Map<string, number>();
  private cursor: SweepCursor | undefined;
  private sweepActive = false;
  private sweepWaiters: Array<() => void> = [];
  private turn: "wake" | "sweep" = "wake";
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly sweepMs: number;
  readonly overflow = { dropped: 0 };

  constructor(private readonly options: TranscriptDeliveryOptions) {
    this.storageLane = options.storageLane ?? new BackendStorageLane();
    this.state = options.deliveryStore ?? new KvTranscriptDeliveryStore(options.node, this.storageLane);
    this.coordinator = options.coordinator ?? new TenantCoordinator();
    this.limiter = options.limiter ?? new ExternalOperationLimiter(4);
    this.lookupApi = {
      lookupMeetingByIdempotencyKey: (key) =>
        this.limiter.run(() => this.options.api.lookupMeetingByIdempotencyKey(key)),
    };
    this.governor = options.governor ?? new WriteGovernor(6);
    this.accessCache = options.delegationCache ?? new DelegationCache();
    this.sweepMs = options.sweepMs ?? 600_000;
  }

  /** Called under the same tenant coordinator as delivery after a grant changes. */
  invalidateGrant(address: string, envelope?: string): void {
    address = address.toLowerCase();
    const cached = this.grants.get(address)?.envelope;
    this.grants.delete(address);
    for (const stale of [cached, envelope]) {
      if (!stale) continue;
      this.accessCache.evict(verificationCacheKey(address, stale, this.options.backendDid, this.options.configuredHost));
      evictStoredGrantVerification(address, stale, this.options.backendDid, this.options.configuredHost);
    }
  }

  start(): void {
    if (!this.stopped && this.timer) return;
    this.stopped = false;
    this.schedule(30_000);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    await this.flush();
    this.finishSweep();
  }
  async hasSchemaMissing(address: string): Promise<boolean> {
    const state = this.dirty.get(address.toLowerCase());
    return state ? Object.values(state.retry).some((entry) => entry.code === "schema_missing")
      : this.state.hasSchemaMissing(address);
  }

  /** The first pass is delayed at boot; explicit sweeps are useful for recovery and deterministic tests. */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    this.sweepActive = true;
    const completed = new Promise<void>((resolve) => this.sweepWaiters.push(resolve));
    this.pump();
    await completed;
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.sweep(); }, delay);
    this.timer.unref?.();
  }

  /** Admission cannot activate a grant or call the upstream API. */
  async wake(address: string, id: string, kind: WakeKind): Promise<void> {
    address = address.toLowerCase();
    if (this.stopped || !this.options.eligibility(address)) return;
    if (!(await this.options.index.list(address)).includes(id)) return;
    const state = this.dirty.get(address) ?? await this.state.read(address);
    const final = state.done[id];
    if (final && final.how !== "cancelled") return;
    const key = `${address}:${id}`;
    if (this.queued.has(key)) return;
    if (this.queue.length >= 1000) { this.overflow.dropped++; return; }
    this.queued.add(key);
    this.queue.push({ address, id, kind });
    this.pump();
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    this.running = this.drain().catch(() => {
      console.warn("[transcript-delivery] op=drain result=error");
      this.finishSweep();
    }).finally(() => {
      this.running = undefined;
      if (!this.stopped && (this.queue.length || this.sweepActive)) this.pump();
    });
  }
  private async drain(): Promise<void> {
    let wakeProcessed = 0;
    try {
      while (!this.stopped && (this.queue.length || this.sweepActive)) {
        const useSweep = this.sweepActive && (this.queue.length === 0 || this.turn === "sweep");
        if (useSweep) {
          const item = await this.nextSweepItem();
          if (!item) { await this.flush(); this.finishSweep(); continue; }
          this.turn = "wake";
          if (item.kind !== "intent") await this.process(item);
          continue;
        }
        const item = this.queue.shift()!;
        this.turn = "sweep";
        try { await this.process(item); }
        finally { this.queued.delete(`${item.address}:${item.id}`); }
        if (++wakeProcessed === 1000) {
          await this.flush();
          wakeProcessed = 0;
        }
      }
    } finally {
      await this.flush();
    }
  }
  private finishSweep(): void {
    if (!this.sweepActive) return;
    this.sweepActive = false;
    for (const resolve of this.sweepWaiters.splice(0)) resolve();
    this.schedule(this.sweepMs);
  }
  private async process(item: Item): Promise<void> {
    try {
      await this.coordinator.run(item.address, () => this.deliverOne(item.address, item.id, item.kind));
    } catch (error) {
      console.warn(`[transcript-delivery] op=deliver result=error id=${item.id} code=delivery_error`);
      const state = await this.loadState(item.address);
      this.retry(item.address, state, item.id, this.errorCode(error), this.retryAfter(error));
    }
  }

  /** A direct call has the same durability semantics as a wake burst. */
  async deliver(address: string, id: string, kind: WakeKind = "completed"): Promise<void> {
    address = address.toLowerCase();
    try { await this.coordinator.run(address, () => this.deliverOne(address, id, kind)); }
    finally { await this.flush(); }
  }

  private async loadState(address: string): Promise<DeliveryState> {
    return this.dirty.get(address) ?? this.state.read(address);
  }
  private changed(address: string, state: DeliveryState): void {
    this.dirty.set(address, state);
    this.state.stage(address, state);
  }
  private prune(address: string, state: DeliveryState, ids: string[]): Set<string> {
    const indexed = new Set(ids);
    let changed = false;
    for (const markers of [state.done, state.watch, state.retry]) {
      for (const key of Object.keys(markers)) {
        if (!indexed.has(key)) { delete markers[key]; changed = true; }
      }
    }
    if (changed) this.changed(address, state);
    return indexed;
  }
  private async flush(): Promise<void> {
    for (const [address, state] of this.dirty) {
      try {
        await this.governor.take();
        await this.state.write(address, state);
        this.dirty.delete(address);
      } catch {
        console.warn("[transcript-delivery] op=state result=error");
      }
    }
  }
  private done(address: string, state: DeliveryState, id: string, how: DeliveryOutcome): void {
    state.done[id] = { at: Date.now(), how };
    delete state.retry[id]; delete state.watch[id];
    this.changed(address, state);
  }
  private retry(address: string, state: DeliveryState, id: string, code: string, retryAfter = 0): void {
    const attempts = (state.retry[id]?.attempts ?? 0) + 1;
    const base = code === "storage_quota" || attempts >= 10 ? 86_400_000 : Math.min(21_600_000, 60_000 * 2 ** (attempts - 1));
    state.retry[id] = { attempts, code, nextAt: Date.now() + Math.max(base * (1 + Math.random() * 0.2), retryAfter) };
    this.changed(address, state);
    if (code === "schema_missing") console.info(`[transcript-delivery] op=deliver result=schema_missing id=${id}`);
  }
  private errorCode(error: unknown): string {
    const status = this.status(error);
    if (status === 402) return "storage_quota";
    if (this.isSchemaMissing(error)) return "schema_missing";
    return status && status >= 500 ? "storage_error" : "upstream_unavailable";
  }
  private status(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    if ("status" in error && typeof error.status === "number") return error.status;
    if ("error" in error && error.error && typeof error.error === "object" &&
      "status" in error.error && typeof error.error.status === "number") return error.error.status;
    return undefined;
  }
  private retryAfter(error: unknown): number {
    return error instanceof TranscriptionApiError ? error.retryAfterMs ?? 0 : 0;
  }
  private isSchemaMissing(error: unknown): boolean {
    return !!error && typeof error === "object" &&
      (("code" in error && error.code === "SCHEMA_MISSING") ||
      ("message" in error && /no such table\b|relation [^\n]{1,128} does not exist\b/i.test(String(error.message))));
  }

  private async grant(address: string): Promise<{ envelope: string; verified: VerifiedTranscriptWriter } | null> {
    const cached = this.grants.get(address);
    let envelope = cached && cached.until > Date.now() ? cached.envelope : undefined;
    if (envelope === undefined) {
      const stored = await this.options.delegationStore.load(address);
      envelope = stored?.serialized ?? null;
      this.grants.set(address, { envelope, until: Date.now() + 60_000 });
      if (this.grants.size > 10_000) this.grants.delete(this.grants.keys().next().value!);
    }
    if (!envelope) return null;
    const result = await parseStoredGrant(address, envelope, {
      backendDid: this.options.backendDid, configuredHost: this.options.configuredHost,
    }, { computeDelegationCid: this.options.node.computeDelegationCid.bind(this.options.node) });
    if (!result.ok || result.verified.ownerAddress !== address ||
      result.verified.spaceId !== makePkhSpaceId(address, result.verified.chainId, "applications")) {
      await this.removeGrant(address, envelope);
      return null;
    }
    return { envelope, verified: result.verified };
  }
  private async removeGrant(address: string, envelope: string): Promise<void> {
    this.invalidateGrant(address, envelope);
    await this.governor.take();
    await this.storageLane.run(async () => {
      if ((await this.options.delegationStore.load(address))?.serialized === envelope) {
        await this.options.delegationStore.remove(address);
      }
    });
  }

  private async deliverOne(address: string, id: string, kind?: WakeKind): Promise<boolean> {
    if (!this.options.eligibility(address)) return false;
    const ids = await this.options.index.list(address);
    const state = await this.loadState(address);
    const indexed = this.prune(address, state, ids);
    if (!indexed.has(id)) return false;
    const previous = state.done[id];
    if (previous && (previous.how !== "cancelled" || kind !== "completed")) return false;
    // A completion wake reopens cancelled/failed meetings even when the throttle
    // postpones the upstream read; retry history remains until actual success.
    if (kind === "completed" && (previous || state.watch[id])) {
      delete state.done[id]; delete state.watch[id];
      this.changed(address, state);
    }
    const now = Date.now();
    if (kind !== "completed" && ((state.retry[id]?.nextAt ?? 0) > now || (state.watch[id]?.nextAt ?? 0) > now || (this.nextCheckAt.get(`${address}:${id}`) ?? 0) > now)) return false;
    const grant = await this.grant(address);
    if (!grant) return false;
    const throttleKey = `${address}:${id}`;
    if ((this.lastUpstream.get(throttleKey) ?? -Infinity) + 60_000 > now) return false;
    this.lastUpstream.delete(throttleKey);
    this.lastUpstream.set(throttleKey, now);
    if (this.lastUpstream.size > 10_000) {
      for (const [key, calledAt] of this.lastUpstream) {
        if (calledAt + 60_000 > now) break;
        this.lastUpstream.delete(key);
      }
    }
    let meeting: TranscriptionMeeting;
    try { meeting = await this.limiter.run(() => this.options.api.getMeeting(id)); }
    catch (error) {
      if (error instanceof TranscriptionApiError && error.status === 404) this.done(address, state, id, "gone");
      else this.retry(address, state, id, "upstream_unavailable", this.retryAfter(error));
      return true;
    }
    if (meeting.status === "failed") {
      const watch = state.watch[id] ?? { since: now, nextAt: now, checks: 0 };
      const elapsed = now - watch.since;
      const intervals = [15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
      watch.nextAt = now + (elapsed >= 30 * 86_400_000 ? 7 * 86_400_000 : intervals[Math.min(watch.checks, 3)]);
      watch.checks++;
      state.watch[id] = watch;
      delete state.retry[id];
      this.changed(address, state); return true;
    }
    if (meeting.status === "cancelled") { this.done(address, state, id, "cancelled"); return true; }
    if (meeting.status !== "completed") {
      this.nextCheckAt.set(throttleKey, now + this.sweepMs); return true;
    }
    if (meeting.id !== id || typeof meeting.metadata?.tinychat_address !== "string" ||
      meeting.metadata.tinychat_address.toLowerCase() !== address) {
      this.done(address, state, id, "owner_mismatch"); return true;
    }
    if (state.watch[id] || state.done[id]) {
      delete state.watch[id]; delete state.done[id]; this.changed(address, state);
    }
    const cacheKey = verificationCacheKey(address, grant.envelope, this.options.backendDid, this.options.configuredHost);
    let access = this.accessCache.get(cacheKey);
    try {
      if (!access) {
        access = await activateVerifiedDelegation(this.options.node, grant.verified, {
          host: this.options.configuredHost, beforeNodeWrite: () => this.governor.take(),
        });
        this.accessCache.set(cacheKey, access);
      }
      const port = delegatedConnectorPort(access, async (operation) => {
        await this.governor.take();
        return this.options.runInWriteLane ? this.options.runInWriteLane(operation) : operation();
      });
      const existing = await transcriberMeetingInSpace(port, id);
      if (!existing.ok) { await this.portFailure(address, state, id, grant.envelope, existing); return true; }
      if (existing.data) { this.done(address, state, id, "existing"); return true; }
      const transcript = await this.limiter.run(() => this.options.api.getTranscript(id)).catch((error: unknown) => {
        this.retry(address, state, id, "upstream_unavailable", this.retryAfter(error));
        return null;
      });
      if (!transcript) return true;
      if (transcript.pending) { this.retry(address, state, id, "transcript_pending"); return true; }
      if (transcript.transcript.meeting_id !== id) { this.retry(address, state, id, "upstream_unavailable"); return true; }
      const normalized = await normalizeTranscriberTranscript(meeting, transcript.transcript);
      const result = await writeTranscriberMeeting(port, normalized, { ensureSchema: false });
      if (!result.ok) { await this.portFailure(address, state, id, grant.envelope, result); return true; }
      this.done(address, state, id, "written");
      console.info(`[transcript-delivery] op=deliver result=written id=${id}`);
    } catch (error) {
      if (this.status(error) === 401 || this.status(error) === 403) await this.removeGrant(address, grant.envelope);
      else this.retry(address, state, id, this.errorCode(error));
    }
    return true;
  }
  private async portFailure(address: string, state: DeliveryState, id: string, envelope: string,
    result: { code: string; message: string }): Promise<void> {
    if (/^(?:401|403|AUTH_UNAUTHORIZED|AUTH_FORBIDDEN)$/.test(result.code)) await this.removeGrant(address, envelope);
    else this.retry(address, state, id, result.code === "SCHEMA_MISSING" ? "schema_missing" :
      /QUOTA|PAYMENT_REQUIRED|402/i.test(result.code) ? "storage_quota" : "storage_error");
  }

  private async nextSweepItem(): Promise<SweepAction | null> {
    if (!this.cursor) {
      const addresses = await this.options.index.listAddresses();
      this.cursor = { addresses, ai: addresses.length ? Math.floor(Math.random() * addresses.length) : 0, idOffset: 0, pendingOffset: 0, scanned: 0, calls: 0 };
    }
    const cursor = this.cursor;
    if (cursor.calls >= 200 || cursor.scanned >= cursor.addresses.length) {
      if (cursor.scanned >= cursor.addresses.length) this.cursor = undefined;
      else { cursor.calls = 0; cursor.scanned = 0; }
      return null;
    }
    while (cursor.scanned < cursor.addresses.length && cursor.calls < 200) {
      const address = cursor.addresses[cursor.ai];
      if (!this.options.eligibility(address)) { this.advanceAddress(cursor); continue; }
      if (cursor.idOffset === 0) {
        const pending = await this.options.index.listPending(address);
        const intent = pending[cursor.pendingOffset];
        if (intent) {
          let attempted: number;
          try {
            attempted = await resolvePendingCreates(address, this.lookupApi, this.options.index, {
              onlyKey: intent.key, maxLookups: 1, beforeIndexWrite: () => this.governor.take(),
            });
          } catch {
            // A lookup may have succeeded before its index write failed.
            attempted = 1;
            console.warn("[transcript-delivery] op=intent result=error");
          }
          cursor.calls += attempted;
          if ((await this.options.index.listPending(address)).some((row) => row.key === intent.key)) cursor.pendingOffset++;
          if (attempted) return { kind: "intent" };
          continue;
        }
      }
      const ids = await this.options.index.list(address);
      const state = await this.loadState(address);
      if (cursor.idOffset === 0) this.prune(address, state, ids);
      if (cursor.idOffset >= ids.length) { this.advanceAddress(cursor); continue; }
      const id = ids[cursor.idOffset++];
      const now = Date.now();
      const marker = state.done[id];
      if (marker && marker.how !== "cancelled") continue;
      if (marker || (state.retry[id]?.nextAt ?? 0) > now || (state.watch[id]?.nextAt ?? 0) > now ||
        (this.nextCheckAt.get(`${address}:${id}`) ?? 0) > now ||
        (this.lastUpstream.get(`${address}:${id}`) ?? -Infinity) + 60_000 > now) continue;
      // An address with no verified grant is skipped without contacting ptx.
      if (!await this.coordinator.run(address, () => this.grant(address))) { this.advanceAddress(cursor); continue; }
      cursor.calls++;
      return { address, id };
    }
    if (cursor.scanned >= cursor.addresses.length) this.cursor = undefined;
    return null;
  }
  private advanceAddress(cursor: SweepCursor): void {
    cursor.ai = (cursor.ai + 1) % cursor.addresses.length;
    cursor.idOffset = 0;
    cursor.pendingOffset = 0;
    cursor.scanned++;
  }
}
