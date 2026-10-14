import { onInvite, shareDecision, windowsOverlap, type ShareDecision } from "./calendar-autojoin-share.js";
import { calendarAutojoinOutcomes } from "./calendar-autojoin-status-summary.js";
import {
  type CalendarAutojoinStore, type CalendarConnection, type CalendarOccurrence, type SharedCapture, TenantCoordinator,
} from "./calendar-autojoin-store.js";
import {
  calendarMeetEvent, calendarOccurrenceIdentity, dispatchCutoff, eligibleCalendarEvent, ExternalOperationLimiter,
  GoogleCalendarError, inDispatchWindow, type GoogleCalendarEvent, type GoogleCalendarPort,
} from "./google-calendar.js";
import {
  computeCreateRequestHash, TERMINAL_MEETING_STATUSES, TranscriptionApiError,
  type TranscriptionApiClient, type TranscriptionMeeting, type TranscriptionMeetingStatus,
} from "./transcription-api.js";
import { CalendarAutojoinError } from "./calendar-autojoin-connection.js";
import { GoogleOAuthError } from "./google-oauth.js";
import type { TranscriberIndexStore } from "./transcriber-index.js";

/** ptx statuses in which the owner's bot is in, or about to be in, the call. From `processing` on, it has left. */
const BOT_IN_CALL: ReadonlySet<TranscriptionMeetingStatus> = new Set(["queued", "joining", "waiting_for_admission", "in_progress"]);
/** TC-581: the one liveness rule, for attaching and for an attached recipient. `meeting` is the owner's
 *  ptx meeting when it was read (null = 404), undefined when it was not read. */
function ownerCapturing(owner: CalendarOccurrence | null, meeting: TranscriptionMeeting | null | undefined, now: number): boolean {
  if (!owner || owner.phase === "terminal") return false;
  if (!owner.meetingId) return !owner.stopRequested && now < dispatchCutoff(owner) + 60_000;
  return meeting === undefined || (meeting !== null && BOT_IN_CALL.has(meeting.status));
}
const SHARE_CHECK_DEADLINE_MS = 86_400_000;
/** TC-907: past the cutoff, how long a capacity-refused row keeps lookup-only recovery, so a slow
 *  earlier POST that commits late is still found and owned. */
const CAPACITY_RECOVERY_MARGIN_MS = 600_000;
const TICK_MS = 30_000;
/** TC-1047: the timer horizon never drops below this, so the first ticks after a deploy (period not
 *  yet measured) and a sudden jump in the period still arm rows that the next tick would reach late. */
const MIN_HORIZON_MS = 5 * 60_000;
/** TC-1047: at most this many due-time timers; rows past the cap wait for the tick, as before. */
const MAX_DUE_TIMERS = 1_000;
const dueKey = (tenant: string, id: string) => `${tenant.toLowerCase()}\n${id}`;
/** TC-1047: a row whose next step is a dispatch attempt (a first POST, or a retry of one). */
function awaitingDispatch(row: CalendarOccurrence): boolean {
  return (row.phase === "pending" || row.phase === "outcome_unknown") && !row.stopRequested && !row.meetingId && !row.sharedCapture;
}

export interface CalendarAutojoinWorkerOptions {
  store: CalendarAutojoinStore;
  /** TC-1047: the same rows at request lane priority, for one occurrence's dispatch path only. Default `store`. */
  dispatchStore?: CalendarAutojoinStore;
  coordinator: TenantCoordinator;
  /** TC-581: serializes the cross-tenant capture claim per normalized Meet URL. Lock order: tenant, then URL. */
  meetingCoordinator?: TenantCoordinator;
  /** TC-581 `CALENDAR_AUTOJOIN_SHARING`: gates only the transcript grant. Default off. */
  sharingEnabled?: boolean;
  calendar: GoogleCalendarPort;
  connection: {
    accessToken(tenant: string, forceRefresh?: boolean): Promise<string>;
    cleanupEnabling(tenant: string): Promise<void>;
    needsReconnect(tenant: string, generation: number): Promise<void>;
    beginGrantBackfill?(): import("./calendar-autojoin-grants.js").GrantBackfillSnapshot;
    backfillGrantReferences?(rows: CalendarConnection[], store: CalendarAutojoinStore, stopping: () => boolean,
      start?: import("./calendar-autojoin-grants.js").GrantBackfillSnapshot): Promise<void>;
  };
  api: TranscriptionApiClient;
  index: TranscriberIndexStore;
  webhookUrl?: string;
  onRecordingCompleted?: (tenant: string, meetingId: string) => Promise<void>;
  limiter?: ExternalOperationLimiter;
  botName?: string;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Durable intents are authoritative. This worker requires a single backend writer.
 *
 * TC-1047: a row awaiting dispatch also gets a due-time timer, so it is reconciled at its
 * `nextAttemptAt` instead of whenever the tick's row loop next reaches it. Every occurrence write
 * the worker makes re-arms or cancels the row's timer; the tick re-arms rows it lists (and after a
 * restart) and remains the backstop. A row is reconciled by one caller at a time, timer or tick.
 */
export class CalendarAutojoinWorker {
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly options: CalendarAutojoinWorkerOptions;
  private readonly dispatchStore: CalendarAutojoinStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: ExternalOperationLimiter;
  private readonly meetingCoordinator: TenantCoordinator;
  private readonly dueTimers = new Map<string, { row: CalendarOccurrence; timer: ReturnType<typeof setTimeout> }>();
  /** Rows being reconciled now, and the timer fires that found them busy. */
  private readonly inFlight = new Set<string>();
  private readonly refire = new Map<string, CalendarOccurrence>();
  private readonly timerRuns = new Set<Promise<void>>();
  /** Changes during a tick's existing listing/reconciliation, including concurrent timer dispatch. */
  private readonly summaryChanges = new Map<string, Map<string, CalendarOccurrence | null>>();
  /** Tenants whose connection the tick last read as enabled; only their rows get timers. */
  private readonly armable = new Set<string>();
  private tickStartedAt?: number;
  private tickPeriodMs = TICK_MS;
  constructor(options: CalendarAutojoinWorkerOptions) {
    this.options = { ...options, store: this.tracked(options.store) };
    this.dispatchStore = this.tracked(options.dispatchStore ?? options.store);
    this.meetingCoordinator = options.meetingCoordinator ?? new TenantCoordinator();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.limiter = options.limiter ?? new ExternalOperationLimiter();
  }
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const { timer } of this.dueTimers.values()) clearTimeout(timer);
    this.dueTimers.clear();
    this.armable.clear();
    await Promise.all([this.running, ...this.timerRuns]);
  }
  /** TC-1047: the tenant was disabled, disconnected or needs a reconnect. The tick handles its rows. */
  cancelTenant(tenant: string): void {
    const key = tenant.toLowerCase();
    this.armable.delete(key);
    for (const [rowKey, { row, timer }] of this.dueTimers) {
      if (row.tenant.toLowerCase() === key) { clearTimeout(timer); this.dueTimers.delete(rowKey); }
    }
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.reconcile().catch(() => { console.warn("[calendar-autojoin] code=tick_failed"); });
    this.running = run;
    void run.finally(() => { if (this.running === run) this.running = null; });
    return run;
  }
  private async reconcile(): Promise<void> {
    const startedAt = this.now();
    if (this.tickStartedAt !== undefined) this.tickPeriodMs = Math.max(TICK_MS, startedAt - this.tickStartedAt);
    this.tickStartedAt = startedAt;
    const grantSnapshot = this.options.connection.beginGrantBackfill?.();
    const tenants = await this.options.store.listConnections();
    const counts = { rows: 0, scans: 0 };
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, tenants.length) }, async () => {
      while (cursor < tenants.length && !this.stopping) {
        const connection = tenants[cursor++]!;
        try { await this.reconcileTenant(connection.tenant, counts); }
        catch { console.warn("[calendar-autojoin] code=tenant_reconcile_failed"); }
      }
    }));
    await this.options.connection.backfillGrantReferences?.(tenants, this.options.store, () => this.stopping, grantSnapshot);
    // Counts only: never ids, titles or addresses.
    console.log(`[calendar-autojoin] code=tick_done ms=${this.now() - startedAt} tenants=${tenants.length} rows=${counts.rows} scans=${counts.scans} timers=${this.dueTimers.size}`);
  }
  private async reconcileTenant(tenant: string, counts: { rows: number; scans: number }): Promise<void> {
    const { store, connection: credentials } = this.options;
    await credentials.cleanupEnabling(tenant);
    let connection = await store.getConnection(tenant);
    if (!connection) return;
    this.trackTenant(connection);
    if (connection.state === "enabled" && connection.subject && connection.nextScanAt <= this.now()) {
      counts.scans++;
      try {
        const events = await this.google(connection, token => this.options.calendar.listEvents(token, this.now()));
        await this.remember(connection, events);
      } catch (error) {
        const delay = this.retryDelay(error, 3);
        await store.updateConnection(tenant, current => current?.generation === connection!.generation ? {
          ...current, scanComplete: false, errorCode: error instanceof GoogleCalendarError ? error.code : "calendar_scan_failed", nextScanAt: this.now() + Math.max(60_000, delay),
        } : current);
      }
    }
    connection = await store.getConnection(tenant);
    if (!connection) return;
    this.trackTenant(connection);
    const key = tenant.toLowerCase();
    const changes = new Map<string, CalendarOccurrence | null>();
    this.summaryChanges.set(key, changes);
    try {
      const occurrences = await store.listOccurrences(tenant);
      // Preserve listing order for equal-start outcomes before the dispatch-order sort below.
      const snapshot = new Map(occurrences.map(row => [row.id, row]));
      counts.rows += occurrences.length;
      try {
        occurrences.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
        for (const row of occurrences) {
          if (this.stopping) return;
          if (row.phase === "terminal") {
            // Unsent outcomes are visible for a month; sent dedupe markers have no expiry.
            if (row.updatedAt < this.now() - 30 * 86_400_000) await store.deleteOccurrence(tenant, row.id);
            continue;
          }
          if (row.nextAttemptAt > this.now()) { this.arm(row); continue; }
          await this.runRow(row);
        }
      } finally {
        for (const [id, row] of changes) {
          if (row) snapshot.set(id, row); else snapshot.delete(id);
        }
        await this.publishStatusSummary(tenant, [...snapshot.values()]);
      }
    } finally { this.summaryChanges.delete(key); }
  }
  private async publishStatusSummary(tenant: string, occurrences: CalendarOccurrence[]): Promise<void> {
    if (this.stopping) return;
    const outcomes = calendarAutojoinOutcomes(occurrences);
    // At most one background write after reconciliation, deduplicated across all store writers.
    await this.options.store.putStatusSummary(tenant, { version: 1, outcomes });
  }
  private recordSummaryChange(tenant: string, id: string, row: CalendarOccurrence | null): void {
    const changes = this.summaryChanges.get(tenant.toLowerCase());
    if (changes) changes.set(id, row ? structuredClone(row) : null);
  }
  /** Only an enabled tenant's rows get timers; the row loop's arm() cancels the rest. */
  private trackTenant(connection: CalendarConnection): void {
    if (connection.state === "enabled") this.armable.add(connection.tenant.toLowerCase());
    else this.armable.delete(connection.tenant.toLowerCase());
  }
  /** TC-1047: the one entry for reconciling a row, from the tick or its timer. A busy row is skipped. */
  private async runRow(row: CalendarOccurrence): Promise<void> {
    const key = dueKey(row.tenant, row.id);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try { await this.reconcileOccurrence(row); }
    catch (error) { await this.defer(row, error); }
    finally {
      this.inFlight.delete(key);
      // A timer that fired mid-run, with no write since: check the row once more.
      const again = this.refire.get(key);
      this.refire.delete(key);
      if (again && !this.dueTimers.has(key)) this.arm(again);
    }
  }
  /**
   * TC-1047: arm, move or cancel the row's due-time timer. Only after start(), only for an enabled
   * tenant's row awaiting dispatch, and no further out than two tick periods: the tick re-arms.
   */
  private arm(row: CalendarOccurrence): void {
    const key = dueKey(row.tenant, row.id);
    this.refire.delete(key);
    const existing = this.dueTimers.get(key);
    // stop() clears `timer` and every armed timer, so nothing is armed or fires once stopping.
    const wanted = !!this.timer && this.armable.has(row.tenant.toLowerCase()) && awaitingDispatch(row);
    if (wanted && existing?.row.nextAttemptAt === row.nextAttemptAt) { existing.row = row; return; }
    if (existing) { clearTimeout(existing.timer); this.dueTimers.delete(key); }
    const delay = row.nextAttemptAt - this.now();
    if (!wanted || delay > this.horizon() || this.dueTimers.size >= MAX_DUE_TIMERS) return;
    const timer = setTimeout(() => this.fire(key), Math.max(0, delay));
    timer.unref?.();
    this.dueTimers.set(key, { row, timer });
  }
  private fire(key: string): void {
    const entry = this.dueTimers.get(key);
    if (!entry) return;
    this.dueTimers.delete(key);
    if (this.inFlight.has(key)) { this.refire.set(key, entry.row); return; }
    const run = this.runRow(entry.row).catch(() => { console.warn("[calendar-autojoin] code=due_timer_failed"); });
    this.timerRuns.add(run);
    void run.finally(() => this.timerRuns.delete(run));
  }
  /** Twice the observed tick period (a tick still running counts in whole 30 s fires), at least MIN_HORIZON_MS. */
  private horizon(): number {
    const running = this.tickStartedAt === undefined || !this.running ? 0 : this.now() - this.tickStartedAt;
    return Math.max(MIN_HORIZON_MS, 2 * Math.max(this.tickPeriodMs, Math.ceil(running / TICK_MS) * TICK_MS));
  }
  /**
   * TC-1047: every occurrence write the worker makes re-arms or cancels that row's due-time timer.
   * The worker deletes only terminal rows, whose timers their terminal write already cancelled.
   */
  private tracked(store: CalendarAutojoinStore): CalendarAutojoinStore {
    return Object.assign(Object.create(store) as CalendarAutojoinStore, {
      putOccurrence: async (row: CalendarOccurrence) => { await store.putOccurrence(row); this.recordSummaryChange(row.tenant, row.id, row); this.arm(row); },
      updateOccurrence: async (tenant: string, id: string, update: Parameters<CalendarAutojoinStore["updateOccurrence"]>[2]) => {
        const row = await store.updateOccurrence(tenant, id, update);
        if (row) { this.recordSummaryChange(tenant, id, row); this.arm(row); }
        return row;
      },
      deleteOccurrence: async (tenant: string, id: string) => { await store.deleteOccurrence(tenant, id); this.recordSummaryChange(tenant, id, null); },
    });
  }
  private async google<T>(connection: CalendarConnection, fn: (token: string) => Promise<T>): Promise<T> {
    let refreshed = false;
    for (let retry = 0; ; retry++) {
      try { return await fn(await this.options.connection.accessToken(connection.tenant, refreshed)); }
      catch (error) {
        if (error instanceof GoogleCalendarError && error.status === 401 && !refreshed) { refreshed = true; retry--; continue; }
        if (error instanceof GoogleCalendarError && error.requiresReconnect) {
          await this.options.connection.needsReconnect(connection.tenant, connection.generation);
        }
        const delay = this.retryDelay(error, retry);
        if (!(error instanceof GoogleCalendarError && error.retryable) || retry >= 2 || delay > 2000 || this.stopping) throw error;
        await this.sleep(delay);
      }
    }
  }
  private async remember(connection: CalendarConnection, events: GoogleCalendarEvent[]): Promise<void> {
    const { store, coordinator } = this.options;
    // Discovery precedes the storage lane: its latency belongs to dispatch lag, not discovery lag.
    const firstSeenAt = this.now();
    await coordinator.run(connection.tenant, async () => {
      const current = await store.getConnection(connection.tenant);
      if (!current || current.state !== "enabled" || current.generation !== connection.generation || current.subject !== connection.subject) return;
      const known = await store.listOccurrences(connection.tenant);
      for (const event of events) {
        const id = calendarOccurrenceIdentity(connection.tenant, connection.subject!, event);
        const old = known.find(row => row.subject === connection.subject && (row.id === id || row.eventId === event.id));
        if (old?.idempotencyKey || old?.meetingId || old?.sharedCapture) continue; // Frozen attempts are checked individually.
        const eligible = eligibleCalendarEvent(event);
        const candidate = eligible ?? (!event.organizer?.self ? calendarMeetEvent(event) : null);
        if (!candidate || !id) {
          if (old && old.phase !== "terminal") await this.finish(old, "event_ineligible");
          continue;
        }
        if (!eligible && event.attendees?.find(attendee => attendee.self)?.responseStatus === "declined") {
          if (old?.phase === "pending") await this.finish(old, "event_ineligible");
          else if (old?.disposition === "not_accepted") await store.deleteOccurrence(connection.tenant, old.id);
          continue;
        }
        if (await store.getMarker(connection.tenant, id)) continue;
        const next: CalendarOccurrence = {
          id, tenant: connection.tenant, subject: connection.subject!, ...candidate,
          firstSeenAt: old?.id === id ? old.firstSeenAt ?? firstSeenAt : firstSeenAt,
          phase: "pending", nextAttemptAt: Math.max(this.now(), candidate.start - 60_000),
          attemptCount: 0, stopRequested: false, updatedAt: this.now(),
        };
        // Preserve backoff when discovery has not changed the occurrence.
        if (old?.phase === "pending" && old.start === next.start && old.end === next.end && old.meetingUrl === next.meetingUrl) {
          next.nextAttemptAt = old.nextAttemptAt;
          next.attemptCount = old.attemptCount;
        }
        if (!eligible) {
          next.phase = "terminal";
          next.disposition = "not_accepted";
          // RSVP outcomes are unchanged by scan timing. Avoid another write on the shared storage lane.
          if (old?.id === next.id && old.phase === "terminal" && !old.errorCode
            && old.disposition === next.disposition && old.firstSeenAt === next.firstSeenAt
            && old.start === next.start && old.end === next.end && old.meetingUrl === next.meetingUrl
            && old.title === next.title) continue;
        }
        else if (this.now() >= dispatchCutoff(next)) { next.phase = "terminal"; next.disposition = "missed_window"; }
        await store.putOccurrence(next);
      }
      // TC-1047: a timer's dispatch records lastDispatchLag outside this lock; keep the latest one.
      await store.updateConnection(connection.tenant, latest => ({ ...current, lastDispatchLag: latest?.lastDispatchLag,
        scanComplete: true, errorCode: undefined, lastScanAt: this.now(), nextScanAt: this.now() + 55_000 + Math.floor(this.random() * 10_000) }));
    });
  }
  private async reconcileOccurrence(original: CalendarOccurrence): Promise<void> {
    // TC-1047: the dispatch path reads and writes at request priority; recording and shared rows do not.
    let row = await (awaitingDispatch(original) ? this.dispatchStore : this.options.store).getOccurrence(original.tenant, original.id);
    // A tick's snapshot can be older than a timer run that has since ended the row.
    if (!row || row.phase === "terminal") return;
    // For legacy rows, record the first observation by this version; never invent old discovery timing.
    if (row.firstSeenAt === undefined) {
      row = await this.options.store.updateOccurrence(row.tenant, row.id,
        current => current && { ...current, firstSeenAt: current.firstSeenAt ?? this.now() });
      if (!row) return;
    }
    if (row.sharedCapture) { await this.reconcileShared(row); return; }
    if (row.meetingId) { await this.reconcileRecording(row); return; }
    if (row.idempotencyKey) {
      // Even disabled tenants and expired Google grants retain this read-only recovery path.
      const lookup = await this.limiter.run(() => this.options.api.lookupMeetingByIdempotencyKey(row!.idempotencyKey!));
      if (lookup) {
        if (lookup.requestHash !== row.requestHash || !this.matchesMetadata(row, lookup.meeting)) {
          await this.options.store.updateOccurrence(row.tenant, row.id, current => current && { ...current, stopRequested: true, errorCode: "lookup_identity_mismatch", nextAttemptAt: this.now() + 900_000 });
          return;
        }
        if (!inDispatchWindow(row, this.now())) row = (await this.requestStop(row, "missed_window"))!;
        await this.acceptRecording(row, lookup.meeting);
        return;
      }
      // TC-907: ptx checks the key before capacity, so a capacity 429 created nothing. Past the
      // cutoff no further create is sent; after a margin for a slow earlier POST that commits late,
      // nothing can appear: end it instead of polling forever.
      if (row.capacityExhausted && this.now() >= dispatchCutoff(row) + CAPACITY_RECOVERY_MARGIN_MS) { await this.finish(row, "capacity_exhausted"); return; }
    }
    const connection = await this.dispatchStore.getConnection(row.tenant);
    if (!this.canDispatch(connection, row)) {
      if (row.idempotencyKey) {
        if (!row.stopRequested) await this.requestStop(row, this.now() >= dispatchCutoff(row) ? "missed_window" : "autojoin_disabled");
        await this.defer(row, undefined);
      }
      else if (connection?.state !== "enabled" || connection.subject !== row.subject) await this.finish(row, "autojoin_disabled");
      else if (this.now() >= dispatchCutoff(row)) await this.finish(row, "missed_window");
      return;
    }
    await this.dispatch(row, connection!);
  }
  private canDispatch(connection: CalendarConnection | null, row: CalendarOccurrence): boolean {
    return !this.stopping && connection?.state === "enabled" && connection.subject === row.subject && (connection.scanComplete || !!row.idempotencyKey) && !row.stopRequested && !row.meetingId &&
      (row.generation === undefined || row.generation === connection.generation) && inDispatchWindow(row, this.now());
  }
  private async dispatch(initial: CalendarOccurrence, connection: CalendarConnection): Promise<void> {
    let row = initial;
    // Two immediate retries; each one traverses Google policy + tenant lock again.
    for (let attempt = 0; attempt < 3 && !this.stopping; attempt++) {
      const event = await this.google(connection, token => this.options.calendar.getEvent(token, row.eventId));
      const eligible = event && eligibleCalendarEvent(event);
      if (!eligible || calendarOccurrenceIdentity(row.tenant, row.subject, event!) !== row.id) {
        // A frozen POST may already have committed. Preserve lookup-only recovery and never
        // promise that accepting again can restart it; its occurrence must remain deduplicated.
        const reason = !row.idempotencyKey && event && calendarOccurrenceIdentity(row.tenant, row.subject, event) === row.id
          && !event.organizer?.self && calendarMeetEvent(event)
          && event.attendees?.find(attendee => attendee.self)?.responseStatus !== "declined"
          ? "not_accepted" : "event_ineligible";
        if (row.idempotencyKey) { await this.requestStop(row, reason); await this.defer(row, undefined); }
        else await this.finish(row, reason);
        return;
      }
      if (row.idempotencyKey && (eligible.start !== row.start || eligible.end !== row.end || eligible.meetingUrl !== row.meetingUrl)) {
        await this.requestStop(row, "event_changed"); await this.defer(row, undefined); return;
      }
      if (!row.idempotencyKey) row = { ...row, ...eligible };
      if (!inDispatchWindow(row, this.now())) {
        if (row.idempotencyKey) { await this.requestStop(row, "missed_window"); await this.defer(row, undefined); }
        else if (this.now() >= dispatchCutoff(row)) await this.finish(row, "missed_window");
        else await this.options.store.updateOccurrence(row.tenant, row.id, current => current && { ...current, ...eligible, nextAttemptAt: eligible.start - 60_000 });
        return;
      }
      // TC-581: read owners' ptx meetings BEFORE the locks; never do upstream I/O while holding them.
      const observed = row.idempotencyKey ? new Map<string, TranscriptionMeeting | null>() : await this.observeOwners(row);
      // Reserve external capacity BEFORE entering tenant coordination. A queued dispatch may
      // not leave the lock and then send after a disable; the actual POST begins inside it.
      let sent = false; // TC-907: only a sent POST was counted when its intent was written.
      let dispatchLag: CalendarConnection["lastDispatchLag"];
      const response = await this.limiter.run(async () => {
        let posted: Promise<TranscriptionMeeting> | undefined;
        await this.options.coordinator.run(row.tenant, async () => {
          const latest = await this.dispatchStore.getOccurrence(row.tenant, row.id);
          const current = await this.dispatchStore.getConnection(row.tenant);
          if (!latest || !this.canDispatch(current, { ...row, stopRequested: latest.stopRequested, meetingId: latest.meetingId })) return;
          // TC-1047: a snapshot that another caller has since superseded (a scan ended the row, or
          // another attempt froze an intent) never sends. A row is reconciled by one caller at a
          // time, so this is the backstop to that guard.
          if (latest.phase === "terminal" || (latest.idempotencyKey && !row.idempotencyKey)) return;
          if (!row.idempotencyKey) {
            // TC-581: another tenant's live capture of this Meet in an overlapping window means no POST.
            if (await this.claimOrAttach(row, current!, event!, observed)) return;
            const body = {
              meeting_url: row.meetingUrl, platform: "google_meet", bot_name: this.options.botName ?? "TinyCloud Private Notetaker",
              metadata: { tinychat_address: row.tenant, source: "google-calendar-autojoin", calendar_occurrence_id: row.id, calendar_title: row.title, scheduled_start: new Date(row.start).toISOString() },
              ...(this.options.webhookUrl ? { webhook_url: this.options.webhookUrl } : {}),
            };
            row = { ...row, generation: current!.generation, createBody: body, requestHash: computeCreateRequestHash(body), idempotencyKey: `calendar-v1-${row.id}` };
          }
          // The one attemptCount increment for this attempt (TC-907): defer() does not count it again.
          row = { ...row, phase: "outcome_unknown", attemptCount: row.attemptCount + 1, capacityExhausted: undefined, updatedAt: this.now(), nextAttemptAt: this.now() + 60_000 };
          await this.dispatchStore.putOccurrence(row); // Failure here MUST imply zero POSTs.
          // Durable storage can take us past the deadline. Do not send a now-ineligible
          // request; keep its frozen intent so a restart can conservatively recover it.
          if (this.stopping || !inDispatchWindow(row, this.now())) {
            await this.requestStop(row, "missed_window");
            return;
          }
          // Do not await while holding the lock: disable must persist during an in-flight POST.
          const sentAt = this.now();
          posted = this.options.api.createMeeting(row.createBody!, { idempotencyKey: row.idempotencyKey, retryTransport: false });
          sent = true;
          void posted.catch(() => {});
          dispatchLag = { sentAt, seconds: (sentAt - row.start) / 1000, discovered: (row.firstSeenAt! - row.start) / 1000 };
          console.log(`[calendar-autojoin] code=dispatch_lag seconds=${dispatchLag.seconds} discovered=${dispatchLag.discovered}`);
        });
        if (!posted) return null;
        return posted;
      }).then(meeting => ({ meeting, error: undefined as unknown }), error => ({ meeting: null, error }));
      if (dispatchLag) {
        const lag = dispatchLag;
        try {
          await this.dispatchStore.updateConnection(row.tenant, current => current?.subject === row.subject
            && current.generation === connection.generation && (current.lastDispatchLag?.sentAt ?? -Infinity) <= lag.sentAt
            ? { ...current, lastDispatchLag: lag } : current);
        } catch { console.warn("[calendar-autojoin] code=dispatch_lag_status_failed"); }
      }
      if (response.meeting) { await this.acceptRecording(row, response.meeting); return; }
      if (!response.error) return;
      await this.defer(row, response.error, sent);
      // A permanent create rejection must never become another POST on the next tick.
      // Retain lookup-only recovery in case any earlier transport attempt committed.
      if (!this.retryable(response.error)) await this.requestStop(row, "create_rejected");
      const delay = this.retryDelay(response.error, attempt);
      // A lost response may already have committed. Always lookup before any further POST.
      let lookup: Awaited<ReturnType<TranscriptionApiClient["lookupMeetingByIdempotencyKey"]>>;
      // The attempt is already deferred; a failed lookup must not defer (and count) it again.
      // The next tick looks up before it can POST.
      try { lookup = await this.limiter.run(() => this.options.api.lookupMeetingByIdempotencyKey(row.idempotencyKey!)); }
      catch { return; }
      if (lookup) {
        if (lookup.requestHash !== row.requestHash || !this.matchesMetadata(row, lookup.meeting)) { await this.requestStop(row, "lookup_identity_mismatch"); return; }
        if (!inDispatchWindow(row, this.now())) row = (await this.requestStop(row, "missed_window"))!;
        await this.acceptRecording(row, lookup.meeting); return;
      }
      if (!this.retryable(response.error) || attempt >= 2 || delay > 2000 || this.now() + delay >= dispatchCutoff(row)) return;
      await this.sleep(delay);
    }
  }
  private matchesMetadata(row: CalendarOccurrence, meeting: TranscriptionMeeting): boolean {
    return meeting.metadata?.tinychat_address === row.tenant && meeting.metadata?.calendar_occurrence_id === row.id && meeting.metadata?.source === "google-calendar-autojoin";
  }
  private async acceptRecording(row: CalendarOccurrence, meeting: TranscriptionMeeting): Promise<void> {
    if (!meeting.id || !this.matchesMetadata(row, meeting)) { await this.requestStop(row, "lookup_identity_mismatch"); return; }
    const saved = await this.dispatchStore.updateOccurrence(row.tenant, row.id, current => current && {
      ...current, meetingId: meeting.id, phase: "ownership_pending", nextAttemptAt: this.now(), updatedAt: this.now(),
      errorCode: current.stopRequested ? current.errorCode : undefined,
    });
    if (saved) await this.reconcileRecording(saved);
  }
  private async reconcileRecording(row: CalendarOccurrence): Promise<void> {
    const { store, index } = this.options;
    // Idempotently repair ownership BEFORE compaction, stops, or marking resolution.
    // TC-1047: these are the post-send writes, at the dispatch path's priority.
    if (row.phase === "ownership_pending") {
      await index.add(row.tenant, row.meetingId!);
      await this.dispatchStore.putMarker({ tenant: row.tenant, id: row.id, meetingId: row.meetingId, disposition: "sent" });
      row = (await this.dispatchStore.updateOccurrence(row.tenant, row.id, current => current && { ...current, phase: current.stopRequested ? "stop_pending" : "sent", createBody: undefined, updatedAt: this.now() }))!;
    }
    const connection = await store.getConnection(row.tenant);
    if (connection?.state !== "enabled" || connection.subject !== row.subject || connection.generation !== row.generation) row = (await this.requestStop(row, "autojoin_disabled"))!;
    if (!row.stopRequested && connection?.state === "enabled" && connection.subject === row.subject) {
      try {
        const event = await this.google(connection, token => this.options.calendar.getEvent(token, row.eventId));
        const eligible = event && eligibleCalendarEvent(event);
        if (!eligible || eligible.start !== row.start || eligible.end !== row.end || eligible.meetingUrl !== row.meetingUrl) row = (await this.requestStop(row, "event_changed"))!;
      } catch {
        // Google being unavailable cannot block ownership or a previously requested stop.
        const current = await store.getConnection(row.tenant);
        if (current?.state === "needs_reconnect") row = (await this.requestStop(row, "google_needs_reconnect"))!;
      }
    }
    let meeting: TranscriptionMeeting;
    try { meeting = await this.limiter.run(() => this.options.api.getMeeting(row.meetingId!)); }
    catch (error) {
      if (error instanceof TranscriptionApiError && error.status === 404) { await this.finish(row, "recording_deleted"); return; }
      throw error;
    }
    if (TERMINAL_MEETING_STATUSES.has(meeting.status)) {
      // TC-581 backstop: ptx found another bot from this service already in the call (a manual send,
      // or a race the claim map missed). Never share here: drop our own empty meeting.
      if (meeting.status === "failed" && meeting.error?.code === "meeting_already_captured") { await this.alreadyCaptured(row); return; }
      await this.finish(row, meeting.status); return;
    }
    // Reread stop intent: disable can have run during either upstream GET.
    row = (await store.getOccurrence(row.tenant, row.id))!;
    const latest = await store.getConnection(row.tenant);
    if (latest?.state !== "enabled" || latest.generation !== row.generation) row = (await this.requestStop(row, "autojoin_disabled"))!;
    if (row.stopRequested) {
      const stopped = await this.limiter.run(() => this.options.api.stopMeeting(row.meetingId!));
      if (TERMINAL_MEETING_STATUSES.has(stopped.status)) { await this.finish(row, stopped.status); return; }
    }
    await store.updateOccurrence(row.tenant, row.id, current => current && { ...current, nextAttemptAt: this.now() + 60_000, attemptCount: 0, updatedAt: this.now(), errorCode: current.stopRequested ? current.errorCode : undefined });
  }
  private requestStop(row: CalendarOccurrence, code: string): Promise<CalendarOccurrence | null> {
    return this.options.store.updateOccurrence(row.tenant, row.id, current => current && {
      ...current, stopRequested: true, phase: current.meetingId && current.phase !== "ownership_pending" ? "stop_pending" : current.phase, errorCode: code, updatedAt: this.now(),
    });
  }
  private async finish(row: CalendarOccurrence, disposition: string): Promise<void> {
    if (row.meetingId || row.idempotencyKey || row.sharedCapture) await this.options.store.putMarker({ tenant: row.tenant, id: row.id, meetingId: row.meetingId, disposition });
    // Every code on a shared row (pending, unverified, a deferred retry) is superseded by its disposition.
    const clears = (current: CalendarOccurrence) => !!current.sharedCapture || (disposition === "completed" && !current.stopRequested)
      || disposition === "already_recorded" || disposition === "capacity_exhausted";
    await this.options.store.updateOccurrence(row.tenant, row.id, current => current && { ...current, phase: "terminal", disposition, createBody: undefined, requestHash: undefined, updatedAt: this.now(), errorCode: clears(current) ? undefined : current.errorCode });
    if (disposition === "completed" && row.meetingId) {
      await this.options.onRecordingCompleted?.(row.tenant, row.meetingId);
    }
  }
  /**
   * TC-581. Under the URL lock: attach to another tenant's live, overlapping capture of this Meet,
   * or record this occurrence's own claim. Returns true when attached (no POST may follow).
   */
  private claimOrAttach(row: CalendarOccurrence, connection: CalendarConnection, event: GoogleCalendarEvent,
    observed: Map<string, TranscriptionMeeting | null>): Promise<boolean> {
    const store = this.dispatchStore;
    return this.meetingCoordinator.run(row.meetingUrl, async () => {
      const now = this.now();
      const tenant = row.tenant.toLowerCase();
      for (const claim of await store.getCaptureClaims(row.meetingUrl)) {
        if (claim.tenant.toLowerCase() === tenant || !windowsOverlap(claim, row)) continue;
        const owner = await store.getOccurrence(claim.tenant, claim.occurrenceId);
        if (!ownerCapturing(owner, owner?.meetingId ? observed.get(owner.meetingId) : undefined, now)) continue;
        // Finding 2: only a capture my OWN fresh invite corroborates can ever lead to a grant.
        const ownerConnection = await store.getConnection(claim.tenant);
        const corroborated = ownerConnection?.subject === owner!.subject && onInvite(event, ownerConnection.verifiedEmail);
        const sharedCapture: SharedCapture = { ownerTenant: claim.tenant, ownerOccurrenceId: claim.occurrenceId, attachedAt: now, corroborated };
        await store.updateOccurrence(row.tenant, row.id, current => current && {
          ...current, start: row.start, end: row.end, meetingUrl: row.meetingUrl, title: row.title, generation: connection.generation,
          sharedCapture, errorCode: this.pendingCode(sharedCapture), nextAttemptAt: now + 30_000, updatedAt: now,
        });
        console.log(`[calendar-autojoin] code=shared_capture_attached corroborated=${corroborated}`);
        return true;
      }
      await store.updateCaptureClaims(row.meetingUrl, claims => [
        ...claims.filter(claim => !(claim.tenant.toLowerCase() === tenant && claim.occurrenceId === row.id)),
        { tenant: row.tenant, occurrenceId: row.id, start: row.start, end: row.end, updatedAt: now },
      ], now);
      return false;
    });
  }
  /** TC-581. Never stops or deletes the owner's meeting. */
  private async reconcileShared(row: CalendarOccurrence): Promise<void> {
    const { store } = this.options;
    const shared = row.sharedCapture!;
    const connection = await store.getConnection(row.tenant);
    if (connection?.state !== "enabled" || connection.subject !== row.subject || connection.generation !== row.generation) {
      // B never sent a bot: become a plain pending row (no marker), so re-enabling rediscovers it, as before TC-581.
      await this.detach(row); await this.reconcileOccurrence(row); return;
    }
    const owner = await store.getOccurrence(shared.ownerTenant, shared.ownerOccurrenceId);
    const meeting = owner?.meetingId ? await this.ownerMeeting(owner.meetingId) : undefined;
    if (ownerCapturing(owner, meeting, this.now())) { await this.retryShared(row, owner?.meetingId ? 60_000 : 30_000); return; }
    // The owner's bot has left or never came. While B can still send, it sends its own, now.
    if (inDispatchWindow(row, this.now())) { await this.detach(row); await this.reconcileOccurrence(row); return; }
    if (!owner || meeting === undefined) { await this.finish(row, "missed_window"); return; }
    if (meeting === null) { await this.settleShared(row, "already_recorded", { ok: false, reason: "recording_deleted" }); return; }
    if (!TERMINAL_MEETING_STATUSES.has(meeting.status)) { await this.retryShared(row, 60_000); return; } // processing
    // An uncorroborated capture never gets a grant, and the owner's calendar is never read for it.
    if (shared.corroborated !== true) { await this.settleShared(row, "unverified_capture", { ok: false, reason: "owner_not_on_invite" }); return; }
    const decision = await this.authorizeShare(row, owner, connection);
    if (decision === "deferred") return;
    if (!decision.ok) { await this.settleShared(row, "already_recorded", decision); return; }
    if (meeting.status !== "completed") { await this.settleShared(row, "failed", { ok: false, reason: `meeting_${meeting.status}` }); return; }
    const checkedAt = this.now();
    await this.options.index.addShared(row.tenant, owner.meetingId!, {
      ownerTenant: owner.tenant, ownerOccurrenceId: owner.id, recipientOccurrenceId: row.id, checkedAt,
      title: row.title, scheduledStart: new Date(row.start).toISOString(),
    });
    await this.settleShared(row, "shared", decision, checkedAt);
  }
  /** The single grant-time check (TC-581). Fails closed on anything but an affirmative answer. */
  private async authorizeShare(row: CalendarOccurrence, owner: CalendarOccurrence, recipient: CalendarConnection): Promise<ShareDecision | "deferred"> {
    if (this.options.sharingEnabled !== true) return { ok: false, reason: "sharing_disabled" };
    if (!recipient.verifiedEmail) return { ok: false, reason: "no_verified_email" };
    const ownerConnection = await this.options.store.getConnection(owner.tenant);
    if (ownerConnection?.state !== "enabled" || !ownerConnection.subject || ownerConnection.subject !== owner.subject) {
      return { ok: false, reason: "owner_autojoin_disabled" };
    }
    try {
      const event = await this.google(ownerConnection, token => this.options.calendar.getEvent(token, owner.eventId));
      return shareDecision(event, owner, recipient.verifiedEmail);
    } catch (error) {
      // Only an explicit authorization answer denies; KV, decryption, network and unknown errors retry.
      const denied = error instanceof CalendarAutojoinError
        || (error instanceof GoogleCalendarError && !error.retryable)
        || (error instanceof GoogleOAuthError && error.status >= 400 && error.status < 500 && error.status !== 429);
      if (denied) return { ok: false, reason: "owner_authorization_lost" };
      if (this.now() >= row.end + SHARE_CHECK_DEADLINE_MS) return { ok: false, reason: "owner_calendar_unavailable" };
      await this.options.store.updateOccurrence(row.tenant, row.id, current => {
        if (!current || current.phase === "terminal") return current;
        const count = current.attemptCount + 1;
        return { ...current, attemptCount: count, errorCode: this.pendingCode(current.sharedCapture), updatedAt: this.now(),
          nextAttemptAt: Math.max(current.nextAttemptAt, this.now() + Math.max(60_000, this.retryDelay(error, count))) };
      });
      return "deferred";
    }
  }
  private async settleShared(row: CalendarOccurrence, disposition: "shared" | "already_recorded" | "failed" | "unverified_capture", decision: ShareDecision, checkedAt = this.now()): Promise<void> {
    await this.options.store.updateOccurrence(row.tenant, row.id, current => current?.sharedCapture ? {
      ...current, sharedCapture: { ...current.sharedCapture, checkedAt, result: disposition === "shared" ? "shared" : "not_shared",
        ...(decision.ok ? {} : { reason: decision.reason }) },
    } : current);
    if (disposition === "shared") console.log("[calendar-autojoin] code=share_granted");
    else console.log(`[calendar-autojoin] code=share_denied reason=${decision.ok ? "unknown" : decision.reason}`);
    await this.finish(row, disposition);
  }
  /**
   * The visible state of an attached row. Unverified captures never promise a transcript, and with
   * sharing off neither does a corroborated one.
   */
  private pendingCode(shared: SharedCapture | undefined): string {
    if (shared?.corroborated !== true) return "unverified_capture";
    return this.options.sharingEnabled === true ? "shared_capture_pending" : "capture_in_progress";
  }
  /** TC-581: back to a plain pending row. B never sent a bot: nothing to unwind upstream, no marker. */
  private async detach(row: CalendarOccurrence): Promise<void> {
    await this.options.store.updateOccurrence(row.tenant, row.id, current => current && current.phase !== "terminal" ? {
      ...current, sharedCapture: undefined, generation: undefined, phase: "pending", errorCode: undefined,
      attemptCount: 0, nextAttemptAt: this.now(), updatedAt: this.now() } : current);
  }
  private async ownerMeeting(id: string): Promise<TranscriptionMeeting | null> {
    try { return await this.limiter.run(() => this.options.api.getMeeting(id)); }
    catch (error) {
      if (error instanceof TranscriptionApiError && error.status === 404) return null;
      throw error;
    }
  }
  /** The ptx meetings of other tenants' live, overlapping claims on this Meet, read outside any lock. */
  private async observeOwners(row: CalendarOccurrence): Promise<Map<string, TranscriptionMeeting | null>> {
    const store = this.dispatchStore;
    const observed = new Map<string, TranscriptionMeeting | null>();
    const tenant = row.tenant.toLowerCase();
    for (const claim of await store.getCaptureClaims(row.meetingUrl)) {
      if (claim.tenant.toLowerCase() === tenant || !windowsOverlap(claim, row)) continue;
      const owner = await store.getOccurrence(claim.tenant, claim.occurrenceId);
      if (owner?.meetingId && owner.phase !== "terminal") observed.set(owner.meetingId, await this.ownerMeeting(owner.meetingId));
    }
    return observed;
  }
  private async retryShared(row: CalendarOccurrence, delay: number): Promise<void> {
    await this.options.store.updateOccurrence(row.tenant, row.id, current => current && current.phase !== "terminal" ? {
      ...current, errorCode: this.pendingCode(current.sharedCapture), nextAttemptAt: this.now() + delay, updatedAt: this.now(),
    } : current);
  }
  private async alreadyCaptured(row: CalendarOccurrence): Promise<void> {
    await this.options.index.remove(row.tenant, row.meetingId!);
    try { await this.limiter.run(() => this.options.api.deleteMeeting(row.meetingId!)); }
    catch { /* best effort: our own meeting never joined */ }
    console.log("[calendar-autojoin] code=already_captured");
    await this.finish(row, "already_recorded");
  }
  private retryable(error: unknown): boolean {
    return !(error instanceof TranscriptionApiError) || error.status === 429 || error.status >= 500;
  }
  private retryDelay(error: unknown, attemptCount: number): number {
    const retryAfter = error instanceof GoogleCalendarError || error instanceof TranscriptionApiError ? error.retryAfterMs : null;
    return Math.max(retryAfter ?? 0, Math.min(900_000, 500 * 2 ** Math.min(attemptCount, 11) * (1 + this.random() * 0.2)));
  }
  /** `afterCreate`: the error is a create's, whose attempt was counted when it was sent (TC-907). */
  private async defer(row: CalendarOccurrence, error: unknown, afterCreate = false): Promise<void> {
    await (afterCreate ? this.dispatchStore : this.options.store).updateOccurrence(row.tenant, row.id, current => {
      if (!current || current.phase === "terminal") return current;
      const count = afterCreate ? current.attemptCount : current.attemptCount + 1;
      const capacity = afterCreate && error instanceof TranscriptionApiError && error.status === 429 && error.code === "capacity_exhausted";
      // Outside the create window, lookup-only recovery remains durable at low rate forever.
      const delay = this.retryDelay(error, count);
      const recoveryOnly = current.stopRequested || this.now() >= dispatchCutoff(current);
      // A later recovery/read failure must not shorten a Retry-After already persisted
      // for the create. Only successful reconciliation can reset that durable deadline.
      const nextAttemptAt = Math.max(current.nextAttemptAt, this.now() + (recoveryOnly ? Math.max(60_000, delay) : delay));
      return { ...current, attemptCount: count, ...(capacity ? { capacityExhausted: true } : {}), errorCode: current.stopRequested ? current.errorCode : error instanceof GoogleCalendarError ? error.code : "autojoin_retry", nextAttemptAt, updatedAt: this.now() };
    });
  }
}
