import { expect, spyOn, test } from "bun:test";
import { MemoryCalendarAutojoinStore, TenantCoordinator, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { calendarDecisionEvent } from "../services/calendar-autojoin-log-events.js";
import { configureRequestLogAccountHash } from "../request-context.js";
import { calendarOccurrenceIdentity, type GoogleCalendarEvent } from "../services/google-calendar.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";

const tenant = "0xAbC1230000000000000000000000000000dEf456";
const subject = "subject";
const start = Date.parse("2026-11-25T12:00:00Z");
const meetingUrl = "https://meet.google.com/abc-defg-hij";
const event: GoogleCalendarEvent = { id: "private-event-id", status: "confirmed", summary: "PRIVATE_TITLE",
  organizer: { self: false }, attendees: [{ self: true, responseStatus: "needsAction" }],
  start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 1_800_000).toISOString() }, hangoutLink: meetingUrl };

function decisions(write: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return write.mock.calls.map(call => JSON.parse(String(call[0]).trim()) as Record<string, unknown>)
    .filter(record => record.event === "calendar_autojoin_decision");
}

test("ownership pending with stop intent records sent before terminal outcome", async () => {
  const now = start;
  const store = new MemoryCalendarAutojoinStore();
  await store.putConnection({ tenant, subject, state: "enabled", generation: 1,
    scopes: [], nextScanAt: now + 900_000, scanComplete: true });
  const row: CalendarOccurrence = { id: "frozen-occurrence", tenant, subject, eventId: event.id, start, end: start + 1_800_000,
    meetingUrl, title: "PRIVATE_TITLE", phase: "ownership_pending", nextAttemptAt: 0, attemptCount: 1, generation: 1,
    stopRequested: true, meetingId: "meeting-1", updatedAt: now };
  await store.putOccurrence(row);
  const worker = new CalendarAutojoinWorker({ store, coordinator: new TenantCoordinator(), index: new MemoryTranscriberIndexStore(),
    calendar: { async listEvents() { return []; }, async getEvent() { return event; }, async probePrimary() {} },
    connection: { async cleanupEnabling() {}, async accessToken() { return "test-token"; }, async needsReconnect() {} },
    api: { async getMeeting() { return { id: "meeting-1", status: "in_progress" as const }; },
      async stopMeeting() { return { id: "meeting-1", status: "cancelled" as const }; } } as never,
    now: () => now });
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await worker.tick();
    expect(decisions(write).map(record => record.reason)).toEqual(["sent", "cancelled"]);
    expect((await store.getOccurrence(tenant, row.id))?.phase).toBe("terminal");
    write.mockClear();
    await worker.tick();
    expect(decisions(write)).toEqual([]);
  } finally { write.mockRestore(); log.mockRestore(); await worker.stop(); }
});

test("a changed identity is a new RSVP decision even if the old row had the same disposition", async () => {
  const now = start - 30_000;
  const store = new MemoryCalendarAutojoinStore();
  await store.putConnection({ tenant, subject, state: "enabled", generation: 1,
    scopes: [], nextScanAt: 0, scanComplete: false });
  await store.putOccurrence({ id: "old-identity", tenant, subject, eventId: event.id, start, end: start + 1_800_000,
    meetingUrl, title: "PRIVATE_TITLE", phase: "terminal", disposition: "not_accepted", nextAttemptAt: now,
    attemptCount: 0, stopRequested: false, updatedAt: now });
  const worker = new CalendarAutojoinWorker({ store, coordinator: new TenantCoordinator(), index: new MemoryTranscriberIndexStore(),
    calendar: { async listEvents() { return [event]; }, async getEvent() { return event; }, async probePrimary() {} },
    connection: { async cleanupEnabling() {}, async accessToken() { return "test-token"; }, async needsReconnect() {} },
    api: null as never, now: () => now, random: () => 0 });
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  const log = spyOn(console, "log").mockImplementation(() => {});
  configureRequestLogAccountHash("test-only-calendar-log-hmac-key-with-enough-entropy-0123456789");
  try {
    await worker.tick();
    expect(decisions(write)).toEqual([{ event: "calendar_autojoin_decision", reason: "not_accepted", start: new Date(start).toISOString(),
      tenant_hash: calendarDecisionEvent({ tenant, start }, "sent").tenant_hash }]);
    expect((await store.getOccurrence(tenant, calendarOccurrenceIdentity(tenant, subject, event)!))?.disposition).toBe("not_accepted");
  } finally { write.mockRestore(); log.mockRestore(); configureRequestLogAccountHash(undefined); await worker.stop(); }
});
