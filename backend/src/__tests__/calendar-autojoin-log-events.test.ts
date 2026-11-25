import { describe, expect, spyOn, test } from "bun:test";
import { configureRequestLogAccountHash } from "../request-context.js";
import { calendarConnectionEvent, calendarDecisionEvent, calendarTickEvent, type CalendarDecisionReason } from "../services/calendar-autojoin-log-events.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator, type CalendarConnection } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";

const tenant = "0xAbC1230000000000000000000000000000dEf456";
const start = Date.parse("2026-11-25T12:00:00Z");
const key = "test-only-calendar-log-hmac-key-with-enough-entropy-0123456789";

function lines(write: { mock: { calls: unknown[][] } }) {
  return write.mock.calls.map(call => JSON.parse(String(call[0]).trim()) as Record<string, unknown>)
    .filter(event => String(event.event).startsWith("calendar_autojoin_"));
}

describe("calendar autojoin shipped events", () => {
  test("closed decisions use a keyed monthly pseudonym and reject arbitrary reasons", () => {
    configureRequestLogAccountHash(key);
    try {
      const row = { tenant, start };
      const event = calendarDecisionEvent(row, "missed_window");
      expect(event).toEqual({ event: "calendar_autojoin_decision", reason: "missed_window",
        start: "2026-11-25T12:00:00.000Z", tenant_hash: expect.stringMatching(/^[0-9a-f]{12}$/) });
      expect(JSON.stringify(event)).not.toContain(tenant.toLowerCase());
      expect(calendarDecisionEvent(row, "GOOGLE_CANARY_free_text" as "missed_window").reason).toBe("unknown");
      // @ts-expect-error Only a declared decision can reach the builder.
      const invalidReason: CalendarDecisionReason = "GOOGLE_CANARY_free_text";
      void invalidReason;
      configureRequestLogAccountHash(undefined);
      expect(calendarDecisionEvent(row, "sent")).not.toHaveProperty("tenant_hash");
    } finally { configureRequestLogAccountHash(undefined); }
  });

  test("connection codes are closed and omit unconfigured tenant hashes", () => {
    const row = { tenant, state: "needs_reconnect", errorCode: "GOOGLE_CANARY_free_text" } as CalendarConnection;
    expect(calendarConnectionEvent(row)).toEqual({ event: "calendar_autojoin_connection", state: "needs_reconnect", code: "unknown" });
    expect(calendarTickEvent({ tenants: 2, rows: 3, scans: 1, timers_due: 1, scan_complete: false, duration_ms: 40 }))
      .toMatchObject({ event: "calendar_autojoin_tick", scan_complete: false });
  });

  test("tick emits on change or after five minutes and emits every incomplete scan", async () => {
    let now = start - 120_000;
    const store = new MemoryCalendarAutojoinStore();
    await store.putConnection({ tenant, subject: "subject", state: "enabled", generation: 1,
      scopes: [], nextScanAt: 0, scanComplete: false });
    let fail = false;
    const worker = new CalendarAutojoinWorker({ store, coordinator: new TenantCoordinator(),
      calendar: { async listEvents() { if (fail) throw new Error("GOOGLE_CANARY"); return []; }, async getEvent() { return null; }, async probePrimary() {} },
      connection: { async cleanupEnabling() {}, async accessToken() { return "test-token"; }, async needsReconnect() {} },
      api: null as never, index: null as never, now: () => now, random: () => 0 });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.tick();
      expect(lines(write)).toEqual([expect.objectContaining({ event: "calendar_autojoin_tick", tenants: 1, rows: 0, scans: 1, scan_complete: true })]);
      await store.updateConnection(tenant, row => row && { ...row, nextScanAt: now + 900_000 });
      write.mockClear();
      now += 30_000;
      await worker.tick();
      expect(lines(write)).toEqual([expect.objectContaining({ event: "calendar_autojoin_tick", scans: 0 })]);
      write.mockClear();
      now += 1_000;
      await worker.tick();
      expect(lines(write)).toEqual([]);
      now += 300_000;
      await worker.tick();
      expect(lines(write)).toHaveLength(1);
      fail = true;
      await store.updateConnection(tenant, row => row && { ...row, nextScanAt: 0 });
      write.mockClear();
      await worker.tick();
      expect(lines(write).filter(event => event.event === "calendar_autojoin_tick")).toEqual([expect.objectContaining({ scan_complete: false, scans: 1 })]);
      write.mockClear();
      await store.updateConnection(tenant, row => row && { ...row, nextScanAt: 0 });
      await worker.tick();
      expect(lines(write).filter(event => event.event === "calendar_autojoin_tick")).toEqual([expect.objectContaining({ scan_complete: false, scans: 1 })]);
    } finally { write.mockRestore(); log.mockRestore(); await worker.stop(); }
  });

  test("committed connection transitions emit once without private fields", async () => {
    configureRequestLogAccountHash(key);
    const store = new MemoryCalendarAutojoinStore();
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await store.putConnection({ tenant, subject: null, state: "disabled", generation: 0, scopes: [], nextScanAt: 0, scanComplete: false });
      await store.updateConnection(tenant, row => row && { ...row, state: "enabled" });
      await store.updateConnection(tenant, row => row && { ...row, state: "enabled" });
      await store.updateConnection(tenant, row => row && { ...row, state: "needs_reconnect", errorCode: "needs_reconnect" });
      const events = lines(write);
      expect(events.filter(event => event.event === "calendar_autojoin_connection").map(event => [event.state, event.code]))
        .toEqual([["disabled", undefined], ["enabled", undefined], ["needs_reconnect", "needs_reconnect"]]);
      expect(JSON.stringify(events)).not.toContain(tenant.toLowerCase());
    } finally { write.mockRestore(); configureRequestLogAccountHash(undefined); }
  });
  test("an RSVP decision emits once on classification and never leaks event text", async () => {
    configureRequestLogAccountHash(key);
    const store = new MemoryCalendarAutojoinStore();
    const now = start - 30_000;
    await store.putConnection({ tenant, subject: "subject", state: "enabled", generation: 1,
      scopes: [], nextScanAt: 0, scanComplete: false });
    const privateTitle = "GOOGLE_CANARY_private_title";
    const event = { id: "private-event-id", status: "confirmed", summary: privateTitle, organizer: { self: false },
      attendees: [{ self: true, responseStatus: "needsAction" }], start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 1_800_000).toISOString() }, hangoutLink: "https://meet.google.com/abc-defg-hij" } as const;
    const worker = new CalendarAutojoinWorker({ store, coordinator: new TenantCoordinator(),
      calendar: { async listEvents() { return [event]; }, async getEvent() { return event; }, async probePrimary() {} },
      connection: { async cleanupEnabling() {}, async accessToken() { return "test-token"; }, async needsReconnect() {} },
      api: null as never, index: null as never, now: () => now, random: () => 0 });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.tick();
      expect(lines(write).filter(item => item.event === "calendar_autojoin_decision"))
        .toEqual([expect.objectContaining({ reason: "not_accepted", start: new Date(start).toISOString() })]);
      expect(JSON.stringify(lines(write))).not.toContain(privateTitle);
      expect(JSON.stringify(lines(write))).not.toContain(tenant.toLowerCase());
      write.mockClear();
      await store.updateConnection(tenant, row => row && { ...row, nextScanAt: 0 });
      await worker.tick();
      expect(lines(write).filter(item => item.event === "calendar_autojoin_decision")).toEqual([]);
    } finally { write.mockRestore(); log.mockRestore(); configureRequestLogAccountHash(undefined); await worker.stop(); }
  });
});
