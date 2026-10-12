import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/node-sdk/core";
import { normalizeTranscriberTranscript, transcriberMeetingInSpace, writeTranscriberMeeting } from "@tinyboilerplate/core";
import { DelegationCache, type DelegationStore } from "@tinyboilerplate/server";
import { evictStoredGrantVerification, parseStoredGrant, verificationCacheKey, type VerifiedTranscriptWriter } from "../delegation-verify.js";
import { activateVerifiedDelegation, DelegationActivationError } from "../portable-delegation.js";
import { BackendStorageLane } from "./backend-storage-lane.js";
import { TenantCoordinator } from "./calendar-autojoin-store.js";
import { ExternalOperationLimiter } from "./google-calendar.js";
import { resolvePendingCreates, KvJsonKv, type JsonKv, type TranscriberIndexStore } from "./transcriber-index.js";
import { TranscriptionApiError, type TranscriptionApiClient, type TranscriptionMeeting } from "./transcription-api.js";
import { delegatedConnectorPort } from "./user-space-port.js";

export type DeliveryOutcome = "written" | "existing" | "gone" | "owner_mismatch" | "cancelled" | "capacity_exhausted";

/**
 * TC-907: ptx admitted the meeting but never got it a bot within its capacity window, so it failed
 * with `capacity_exhausted`. It has no capture to recover, so it is terminal, not a watched failure.
 */
function capacityEnded(meeting: TranscriptionMeeting): boolean {
  return meeting.status === "failed" && meeting.error?.code === "capacity_exhausted";
}
/** Final for the sweep; a completion wake may still ask upstream (only `cancelled` is reopened up front). */
const WAKE_RECHECKS = new Set<DeliveryOutcome>(["cancelled", "capacity_exhausted"]);
/** The retry classes' schedule: 1 min doubling to 6 h, a day after ten attempts, with 20 % jitter. */
function backoffMs(attempts: number): number {
  const base = attempts >= 10 ? 86_400_000 : Math.min(21_600_000, 60_000 * 2 ** (attempts - 1));
  return base * (1 + Math.random() * 0.2);
}
export interface DeliveryState {
  v: 1;
  done: Record<string, { at: number; how: DeliveryOutcome }>;
  watch: Record<string, { since: number; nextAt: number; checks: number }>;
  retry: Record<string, { attempts: number; nextAt: number; code: string }>;
  /**
   * TC-907: a completion wake on a `capacity_exhausted` meeting, waiting for our own upstream read
   * to confirm it. It survives the read throttle, upstream errors and restarts, and the sweep honours
   * it when due; the terminal marker stays until the read confirms completion for this owner.
   */
  confirm?: Record<string, { attempts: number; nextAt: number }>;
}
const emptyState = (): DeliveryState => ({ v: 1, done: {}, watch: {}, retry: {}, confirm: {} });
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
      confirm: raw.confirm ?? {},
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
/**
 * What admission did with a wake. `ignored` is deliberate (not eligible, not owned, shared, already
 * final) and must look the same as `queued` to a caller. `dropped` means the work was NOT recorded
 * (a full queue, a stopping worker): a webhook must answer retryably so ptx delivers it again.
 */
export type WakeResult = "queued" | "ignored" | "dropped";
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
/** Upstream calls and non-cohort grant-store reads one sweep pass may spend. */
const SWEEP_CALL_CAP = 200;
/** A non-cohort grant check reads once, and once more to compare-and-delete a grant it finds. */
const GRANT_CHECK_READS = 2;

/** Only the node refusing an activation of the grant itself proves the grant is revoked. */
function refusedActivation(error: unknown): boolean {
  return error instanceof DelegationActivationError && (error.status === 401 || error.status === 403);
}

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
  /** Ineligible addresses already checked for a leftover grant; cleared when a grant changes. */
  private readonly ineligibleWithoutGrant = new Set<string>();
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
    this.ineligibleWithoutGrant.delete(address);
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

  /**
   * Admission cannot activate a grant or call the upstream API. It throws when it cannot read the
   * index or delivery state, which a webhook also treats as work not recorded.
   */
  async wake(address: string, id: string, kind: WakeKind): Promise<WakeResult> {
    address = address.toLowerCase();
    if (!this.options.eligibility(address)) return "ignored";
    if (!(await this.ownedIds(address)).includes(id)) return "ignored";
    const state = this.dirty.get(address) ?? await this.state.read(address);
    const final = state.done[id];
    if (final && !WAKE_RECHECKS.has(final.how)) return "ignored";
    const key = `${address}:${id}`;
    if (this.queued.has(key)) return "queued";
    if (this.stopped) return "dropped";
    if (this.queue.length >= 1000) { this.overflow.dropped++; return "dropped"; }
    this.queued.add(key);
    this.queue.push({ address, id, kind });
    this.pump();
    return "queued";
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
    for (const markers of [state.done, state.watch, state.retry, state.confirm ?? {}]) {
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
    delete state.retry[id]; delete state.watch[id]; delete state.confirm?.[id];
    this.changed(address, state);
  }
  private retry(address: string, state: DeliveryState, id: string, code: string, retryAfter = 0): void {
    const attempts = (state.retry[id]?.attempts ?? 0) + 1;
    const wait = code === "storage_quota" ? 86_400_000 * (1 + Math.random() * 0.2) : backoffMs(attempts);
    state.retry[id] = { attempts, code, nextAt: Date.now() + Math.max(wait, retryAfter) };
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

  /**
   * The ids this address owns, from ONE read of its index document. A meeting shared into it
   * (TC-581) is its owner's to deliver, whatever the upstream record says, so it is never admitted,
   * delivered or swept here.
   */
  private async ownedIds(address: string): Promise<string[]> {
    const { ids, shared } = await this.options.index.entries(address);
    return ids.filter((id) => !Object.hasOwn(shared, id));
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
  /**
   * Delivery was turned off for this address (flag off, or narrowed out of the cohort): its stored
   * grant must not stay valid for the rest of its life. Compare-and-delete under the tenant lane.
   */
  /** Returns how many grant-store reads it made (removeGrant re-reads to compare-and-delete). */
  private async dropIneligibleGrant(address: string): Promise<number> {
    if (this.ineligibleWithoutGrant.has(address)) return 0;
    let reads = 0;
    try {
      await this.coordinator.run(address, async () => {
        reads++;
        const stored = await this.options.delegationStore.load(address);
        if (stored) { reads++; await this.removeGrant(address, stored.serialized); }
      });
      this.ineligibleWithoutGrant.add(address);
    } catch {
      console.warn("[transcript-delivery] op=remove_ineligible result=error");
    }
    return reads;
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
    const ids = await this.ownedIds(address);
    const state = await this.loadState(address);
    const indexed = this.prune(address, state, ids);
    if (!indexed.has(id)) return false;
    const previous = state.done[id];
    const capacity = previous?.how === "capacity_exhausted";
    if (previous && !capacity && (!WAKE_RECHECKS.has(previous.how) || !kind)) return false;
    const now = Date.now();
    const throttleKey = `${address}:${id}`;
    const throttledUntil = (this.lastUpstream.get(throttleKey) ?? -Infinity) + 60_000;
    if (capacity) {
      // TC-907: only our own read of a completed meeting, matching id and owner, reopens it. A wake
      // becomes a durable pending confirmation; throttling or an upstream error only reschedules it.
      const confirm = (state.confirm ??= {});
      if (kind && !confirm[id]) { confirm[id] = { attempts: 0, nextAt: now }; this.changed(address, state); }
      const pending = confirm[id];
      if (!pending || pending.nextAt > now) return false;
      if (throttledUntil > now) { pending.nextAt = throttledUntil; this.changed(address, state); return false; }
    } else {
      // A completion wake, or an observation of completion (our own owner-checked upstream read),
      // reopens cancelled/failed meetings even when the throttle postpones the upstream read;
      // retry history remains until actual success.
      if (kind && (previous || state.watch[id])) {
        delete state.done[id]; delete state.watch[id];
        this.changed(address, state);
      }
      // Only a completion wake skips the durable retry backoff (storage errors included); an
      // observation still skips the not-yet-completed re-check, which it has just disproved.
      if (kind !== "completed" && (state.retry[id]?.nextAt ?? 0) > now) return false;
      if (!kind && ((state.watch[id]?.nextAt ?? 0) > now || (this.nextCheckAt.get(throttleKey) ?? 0) > now)) return false;
    }
    const grant = await this.grant(address);
    if (!grant) return false;
    if (throttledUntil > now) return false;
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
      const gone = error instanceof TranscriptionApiError && error.status === 404;
      if (capacity) {
        const pending = state.confirm![id]!;
        // A 404 answers the confirmation (nothing can complete); any other failure retries it later.
        if (gone) delete state.confirm![id];
        // From the moment the error is handled, not `now`: the grant read, limiter and request all
        // took time, and Retry-After counts from the response.
        else { pending.attempts++; pending.nextAt = Date.now() + Math.max(backoffMs(pending.attempts), this.retryAfter(error)); }
        this.changed(address, state);
        return true;
      }
      if (gone) this.done(address, state, id, "gone");
      else this.retry(address, state, id, "upstream_unavailable", this.retryAfter(error));
      return true;
    }
    const ownedCompletion = meeting.status === "completed" && meeting.id === id &&
      typeof meeting.metadata?.tinychat_address === "string" && meeting.metadata.tinychat_address.toLowerCase() === address;
    if (capacity) {
      // Every answer but an owned completion keeps the terminal marker; the confirmation is answered.
      delete state.confirm![id];
      if (ownedCompletion) delete state.done[id];
      this.changed(address, state);
      if (!ownedCompletion) return true;
    }
    if (capacityEnded(meeting)) { this.done(address, state, id, "capacity_exhausted"); return true; }
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
    if (!ownedCompletion) { this.done(address, state, id, "owner_mismatch"); return true; }
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
      if (!existing.ok) { await this.portFailure(address, state, id, grant, existing); return true; }
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
      if (!result.ok) { await this.portFailure(address, state, id, grant, result); return true; }
      this.done(address, state, id, "written");
      console.info(`[transcript-delivery] op=deliver result=written id=${id}`);
    } catch (error) {
      if (refusedActivation(error)) await this.removeGrant(address, grant.envelope);
      else this.retry(address, state, id, this.errorCode(error));
    }
    return true;
  }
  private async portFailure(address: string, state: DeliveryState, id: string,
    grant: { envelope: string; verified: VerifiedTranscriptWriter },
    result: { code: string; message: string; status?: number }): Promise<void> {
    if (result.status === 401 || result.status === 403 ||
      /^(?:401|403|AUTH_UNAUTHORIZED|AUTH_FORBIDDEN|SQL_PERMISSION_DENIED)$/.test(result.code)) {
      await this.confirmRefusal(address, state, id, grant);
      return;
    }
    // SDK 3.1 reports every storage failure with its HTTP status, so the status decides quota: 402
    // (STORAGE_QUOTA_EXCEEDED) and 413 are the day-long quota backoff, while SQL 429
    // (SQL_QUOTA_EXCEEDED, a rate limit) takes the short storage retry. The code is consulted only
    // when there is no status.
    this.retry(address, state, id, result.code === "SCHEMA_MISSING" ? "schema_missing" :
      result.status === 402 || result.status === 413 ||
      (result.status === undefined && /QUOTA|PAYMENT_REQUIRED|402/i.test(result.code))
        ? "storage_quota" : "storage_error");
  }
  /**
   * A storage-time 401/403 may be operational (an ingress, a passing node refusal), and with no tab
   * open a deleted grant has no recovery. So confirm it: drop the cached activation and activate
   * the stored grant once more on the configured host. Only a refused activation deletes the
   * grant; a working one, or a node outage, keeps it and retries with backoff.
   */
  private async confirmRefusal(address: string, state: DeliveryState, id: string,
    grant: { envelope: string; verified: VerifiedTranscriptWriter }): Promise<void> {
    const cacheKey = verificationCacheKey(address, grant.envelope, this.options.backendDid, this.options.configuredHost);
    this.accessCache.evict(cacheKey);
    try {
      const access = await activateVerifiedDelegation(this.options.node, grant.verified, {
        host: this.options.configuredHost, beforeNodeWrite: () => this.governor.take(),
      });
      this.accessCache.set(cacheKey, access);
    } catch (error) {
      if (refusedActivation(error)) { await this.removeGrant(address, grant.envelope); return; }
    }
    this.retry(address, state, id, "storage_error");
  }

  private async nextSweepItem(): Promise<SweepAction | null> {
    if (!this.cursor) {
      const addresses = await this.options.index.listAddresses();
      this.cursor = { addresses, ai: addresses.length ? Math.floor(Math.random() * addresses.length) : 0, idOffset: 0, pendingOffset: 0, scanned: 0, calls: 0 };
    }
    const cursor = this.cursor;
    if (cursor.calls >= SWEEP_CALL_CAP || cursor.scanned >= cursor.addresses.length) return this.endPass(cursor);
    while (cursor.scanned < cursor.addresses.length && cursor.calls < SWEEP_CALL_CAP) {
      const address = cursor.addresses[cursor.ai];
      if (!this.options.eligibility(address)) {
        // Each grant-store read counts against the pass's call cap, so the first sweep after a
        // boot (or a cohort narrowing) does not read every non-cohort address at once. A check
        // that may compare-and-delete needs both its reads in this pass, or it waits for the next.
        if (!this.ineligibleWithoutGrant.has(address) && SWEEP_CALL_CAP - cursor.calls < GRANT_CHECK_READS) break;
        cursor.calls += await this.dropIneligibleGrant(address);
        this.advanceAddress(cursor);
        continue;
      }
      if (cursor.idOffset === 0) {
        let pending: Awaited<ReturnType<TranscriberIndexStore["listPending"]>>;
        try { pending = await this.options.index.listPending(address); }
        catch { this.skipUnreadable(cursor); continue; }
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
          const still = await this.options.index.listPending(address).catch(() => null);
          if (!still) { this.skipUnreadable(cursor); continue; }
          if (still.some((row) => row.key === intent.key)) cursor.pendingOffset++;
          if (attempted) return { kind: "intent" };
          continue;
        }
      }
      let ids: string[];
      let state: DeliveryState;
      try { ids = await this.ownedIds(address); state = await this.loadState(address); }
      catch { this.skipUnreadable(cursor); continue; }
      if (cursor.idOffset === 0) this.prune(address, state, ids);
      if (cursor.idOffset >= ids.length) { this.advanceAddress(cursor); continue; }
      const id = ids[cursor.idOffset++];
      const now = Date.now();
      const marker = state.done[id];
      // A capacity-ended meeting with a due confirmation gets its one upstream read (TC-907).
      const confirming = marker?.how === "capacity_exhausted" && (state.confirm?.[id]?.nextAt ?? Infinity) <= now;
      if (marker && !confirming) continue;
      if (!confirming && ((state.retry[id]?.nextAt ?? 0) > now || (state.watch[id]?.nextAt ?? 0) > now ||
        (this.nextCheckAt.get(`${address}:${id}`) ?? 0) > now)) continue;
      if ((this.lastUpstream.get(`${address}:${id}`) ?? -Infinity) + 60_000 > now) continue;
      // An address with no verified grant is skipped without contacting ptx.
      let granted: boolean;
      try { granted = !!await this.coordinator.run(address, () => this.grant(address)); }
      catch { this.skipUnreadable(cursor); continue; }
      if (!granted) { this.advanceAddress(cursor); continue; }
      cursor.calls++;
      return { address, id };
    }
    return this.endPass(cursor);
  }
  /**
   * End this pass. A finished rotation drops the cursor (the next pass re-lists addresses); a pass
   * that ran out of budget keeps its position and starts the next pass with a fresh budget, so
   * every scheduled sweep does work rather than spending one just resetting the count.
   */
  private endPass(cursor: SweepCursor): null {
    if (cursor.scanned >= cursor.addresses.length) this.cursor = undefined;
    else { cursor.calls = 0; cursor.scanned = 0; }
    return null;
  }
  /** An address whose index, delivery state or grant cannot be read is passed over, not retried here. */
  private skipUnreadable(cursor: SweepCursor): void {
    console.warn("[transcript-delivery] op=sweep result=unreadable_address");
    this.advanceAddress(cursor);
  }
  private advanceAddress(cursor: SweepCursor): void {
    cursor.ai = (cursor.ai + 1) % cursor.addresses.length;
    cursor.idOffset = 0;
    cursor.pendingOffset = 0;
    cursor.scanned++;
  }
}
