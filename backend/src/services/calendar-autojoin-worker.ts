import {
  type CalendarAutojoinStore, type CalendarConnection, type CalendarOccurrence, TenantCoordinator,
} from "./calendar-autojoin-store.js";
import {
  calendarOccurrenceIdentity, dispatchCutoff, eligibleCalendarEvent, ExternalOperationLimiter,
  GoogleCalendarError, inDispatchWindow, type GoogleCalendarEvent, type GoogleCalendarPort,
} from "./google-calendar.js";
import {
  computeCreateRequestHash, TERMINAL_MEETING_STATUSES, TranscriptionApiError,
  type TranscriptionApiClient, type TranscriptionMeeting,
} from "./transcription-api.js";
import type { TranscriberIndexStore } from "./transcriber-index.js";

export interface CalendarAutojoinWorkerOptions {
  store: CalendarAutojoinStore;
  coordinator: TenantCoordinator;
  calendar: GoogleCalendarPort;
  connection: {
    accessToken(tenant: string, forceRefresh?: boolean): Promise<string>;
    cleanupEnabling(tenant: string): Promise<void>;
    needsReconnect(tenant: string, generation: number): Promise<void>;
  };
  api: TranscriptionApiClient;
  index: TranscriberIndexStore;
  limiter?: ExternalOperationLimiter;
  botName?: string;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Durable intents are authoritative. This worker requires a single backend writer. */
export class CalendarAutojoinWorker {
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: ExternalOperationLimiter;
  constructor(private readonly options: CalendarAutojoinWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.limiter = options.limiter ?? new ExternalOperationLimiter();
  }
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
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
    const tenants = await this.options.store.listConnections();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, tenants.length) }, async () => {
      while (cursor < tenants.length && !this.stopping) {
        const connection = tenants[cursor++]!;
        try { await this.reconcileTenant(connection.tenant); }
        catch { console.warn("[calendar-autojoin] code=tenant_reconcile_failed"); }
      }
    }));
  }
  private async reconcileTenant(tenant: string): Promise<void> {
    const { store, connection: credentials } = this.options;
    await credentials.cleanupEnabling(tenant);
    let connection = await store.getConnection(tenant);
    if (!connection) return;
    if (connection.state === "enabled" && connection.subject && connection.nextScanAt <= this.now()) {
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
    const occurrences = await store.listOccurrences(tenant);
    occurrences.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    for (const row of occurrences) {
      if (this.stopping) return;
      if (row.phase === "terminal") {
        // Unsent outcomes are visible for a month; sent dedupe markers have no expiry.
        if (row.updatedAt < this.now() - 30 * 86_400_000) await store.deleteOccurrence(tenant, row.id);
        continue;
      }
      if (row.nextAttemptAt > this.now()) continue;
      try { await this.reconcileOccurrence(row); }
      catch (error) { await this.defer(row, error); }
    }
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
    await coordinator.run(connection.tenant, async () => {
      const current = await store.getConnection(connection.tenant);
      if (!current || current.state !== "enabled" || current.generation !== connection.generation || current.subject !== connection.subject) return;
      const known = await store.listOccurrences(connection.tenant);
      for (const event of events) {
        const id = calendarOccurrenceIdentity(connection.tenant, connection.subject!, event);
        const old = known.find(row => row.subject === connection.subject && (row.id === id || row.eventId === event.id));
        if (old?.idempotencyKey || old?.meetingId) continue; // Frozen attempts are checked individually.
        const eligible = eligibleCalendarEvent(event);
        if (!eligible || !id) {
          if (old && old.phase !== "terminal") await this.finish(old, "event_ineligible");
          continue;
        }
        if (await store.getMarker(connection.tenant, id)) continue;
        const next: CalendarOccurrence = {
          id, tenant: connection.tenant, subject: connection.subject!, ...eligible,
          phase: "pending", nextAttemptAt: Math.max(this.now(), eligible.start - 60_000),
          attemptCount: 0, stopRequested: false, updatedAt: this.now(),
        };
        // Preserve backoff when discovery has not changed the occurrence.
        if (old?.phase === "pending" && old.start === next.start && old.end === next.end && old.meetingUrl === next.meetingUrl) {
          next.nextAttemptAt = old.nextAttemptAt;
          next.attemptCount = old.attemptCount;
        }
        if (this.now() >= dispatchCutoff(next)) { next.phase = "terminal"; next.disposition = "missed_window"; }
        await store.putOccurrence(next);
      }
      await store.putConnection({ ...current, scanComplete: true, errorCode: undefined, lastScanAt: this.now(), nextScanAt: this.now() + 55_000 + Math.floor(this.random() * 10_000) });
    });
  }
  private async reconcileOccurrence(original: CalendarOccurrence): Promise<void> {
    let row = await this.options.store.getOccurrence(original.tenant, original.id);
    if (!row) return;
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
    }
    const connection = await this.options.store.getConnection(row.tenant);
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
        if (row.idempotencyKey) { await this.requestStop(row, "event_ineligible"); await this.defer(row, undefined); }
        else await this.finish(row, "event_ineligible");
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
      // Reserve external capacity BEFORE entering tenant coordination. A queued dispatch may
      // not leave the lock and then send after a disable; the actual POST begins inside it.
      const response = await this.limiter.run(async () => {
        let posted: Promise<TranscriptionMeeting> | undefined;
        await this.options.coordinator.run(row.tenant, async () => {
          const latest = await this.options.store.getOccurrence(row.tenant, row.id);
          const current = await this.options.store.getConnection(row.tenant);
          if (!latest || !this.canDispatch(current, { ...row, stopRequested: latest.stopRequested, meetingId: latest.meetingId })) return;
          if (!row.idempotencyKey) {
            const body = {
              meeting_url: row.meetingUrl, platform: "google_meet", bot_name: this.options.botName ?? "TinyCloud Private Notetaker",
              metadata: { tinychat_address: row.tenant, source: "google-calendar-autojoin", calendar_occurrence_id: row.id, calendar_title: row.title, scheduled_start: new Date(row.start).toISOString() },
            };
            row = { ...row, generation: current!.generation, createBody: body, requestHash: computeCreateRequestHash(body), idempotencyKey: `calendar-v1-${row.id}` };
          }
          row = { ...row, phase: "outcome_unknown", attemptCount: row.attemptCount + 1, updatedAt: this.now(), nextAttemptAt: this.now() + 60_000 };
          await this.options.store.putOccurrence(row); // Failure here MUST imply zero POSTs.
          // Durable storage can take us past the deadline. Do not send a now-ineligible
          // request; keep its frozen intent so a restart can conservatively recover it.
          if (this.stopping || !inDispatchWindow(row, this.now())) {
            await this.requestStop(row, "missed_window");
            return;
          }
          // Do not await while holding the lock: disable must persist during an in-flight POST.
          posted = this.options.api.createMeeting(row.createBody!, { idempotencyKey: row.idempotencyKey, retryTransport: false });
          void posted.catch(() => {});
        });
        if (!posted) return null;
        return posted;
      }).then(meeting => ({ meeting, error: undefined as unknown }), error => ({ meeting: null, error }));
      if (response.meeting) { await this.acceptRecording(row, response.meeting); return; }
      if (!response.error) return;
      await this.defer(row, response.error);
      // A permanent create rejection must never become another POST on the next tick.
      // Retain lookup-only recovery in case any earlier transport attempt committed.
      if (!this.retryable(response.error)) await this.requestStop(row, "create_rejected");
      const delay = this.retryDelay(response.error, attempt);
      // A lost response may already have committed. Always lookup before any further POST.
      const lookup = await this.limiter.run(() => this.options.api.lookupMeetingByIdempotencyKey(row.idempotencyKey!));
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
    const saved = await this.options.store.updateOccurrence(row.tenant, row.id, current => current && {
      ...current, meetingId: meeting.id, phase: "ownership_pending", nextAttemptAt: this.now(), updatedAt: this.now(),
      errorCode: current.stopRequested ? current.errorCode : undefined,
    });
    if (saved) await this.reconcileRecording(saved);
  }
  private async reconcileRecording(row: CalendarOccurrence): Promise<void> {
    const { store, index } = this.options;
    // Idempotently repair ownership BEFORE compaction, stops, or marking resolution.
    if (row.phase === "ownership_pending") {
      await index.add(row.tenant, row.meetingId!);
      await store.putMarker({ tenant: row.tenant, id: row.id, meetingId: row.meetingId, disposition: "sent" });
      row = (await store.updateOccurrence(row.tenant, row.id, current => current && { ...current, phase: current.stopRequested ? "stop_pending" : "sent", createBody: undefined, updatedAt: this.now() }))!;
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
    if (TERMINAL_MEETING_STATUSES.has(meeting.status)) { await this.finish(row, meeting.status); return; }
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
    if (row.meetingId || row.idempotencyKey) await this.options.store.putMarker({ tenant: row.tenant, id: row.id, meetingId: row.meetingId, disposition });
    await this.options.store.updateOccurrence(row.tenant, row.id, current => current && { ...current, phase: "terminal", disposition, createBody: undefined, requestHash: undefined, updatedAt: this.now(), errorCode: disposition === "completed" && !current.stopRequested ? undefined : current.errorCode });
  }
  private retryable(error: unknown): boolean {
    return !(error instanceof TranscriptionApiError) || error.status === 429 || error.status >= 500;
  }
  private retryDelay(error: unknown, attemptCount: number): number {
    const retryAfter = error instanceof GoogleCalendarError || error instanceof TranscriptionApiError ? error.retryAfterMs : null;
    return Math.max(retryAfter ?? 0, Math.min(900_000, 500 * 2 ** Math.min(attemptCount, 11) * (1 + this.random() * 0.2)));
  }
  private async defer(row: CalendarOccurrence, error: unknown): Promise<void> {
    await this.options.store.updateOccurrence(row.tenant, row.id, current => {
      if (!current || current.phase === "terminal") return current;
      const count = current.attemptCount + 1;
      // Outside the create window, lookup-only recovery remains durable at low rate forever.
      const delay = this.retryDelay(error, count);
      const recoveryOnly = current.stopRequested || this.now() >= dispatchCutoff(current);
      // A later recovery/read failure must not shorten a Retry-After already persisted
      // for the create. Only successful reconciliation can reset that durable deadline.
      const nextAttemptAt = Math.max(current.nextAttemptAt, this.now() + (recoveryOnly ? Math.max(60_000, delay) : delay));
      return { ...current, attemptCount: count, errorCode: current.stopRequested ? current.errorCode : error instanceof GoogleCalendarError ? error.code : "autojoin_retry", nextAttemptAt, updatedAt: this.now() };
    });
  }
}
