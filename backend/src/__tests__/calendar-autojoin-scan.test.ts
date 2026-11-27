import { describe, expect, spyOn, test } from "bun:test";
import { configureRequestLogAccountHash } from "../request-context.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { calendarMeetEvent, eligibleCalendarEvent, type GoogleCalendarEvent } from "../services/google-calendar.js";
import { classifyCalendarScanEvent } from "../services/calendar-autojoin-scan.js";

const tenant = "0xAbC1230000000000000000000000000000dEf456";
const start = Date.parse("2026-11-25T12:00:00Z");
const base: GoogleCalendarEvent = { id: "private-event-id", status: "confirmed", summary: "PRIVATE_TITLE",
  organizer: { self: true }, start: { dateTime: new Date(start).toISOString() },
  end: { dateTime: new Date(start + 1_800_000).toISOString() }, hangoutLink: "https://meet.google.com/abc-defg-hij" };

const cases: [GoogleCalendarEvent, string][] = [
  [base, "eligible"],
  [{ ...base, id: "cancelled", status: "cancelled" }, "skipped_not_confirmed"],
  [{ ...base, id: "all-day", start: { date: "2026-11-25" } }, "skipped_not_timed"],
  [{ ...base, id: "bad-time", end: { dateTime: "invalid" } }, "skipped_not_timed"],
  [{ ...base, id: "no-meet", hangoutLink: undefined }, "skipped_no_meet_link"],
  [{ ...base, id: "rsvp", organizer: { self: false }, attendees: [{ self: true, responseStatus: "needsAction" }] }, "skipped_not_accepted"],
  [{ ...base, id: "declined", attendees: [{ self: true, responseStatus: "declined" }] }, "skipped_not_accepted"],
  [{ ...base, id: "missing-id".slice(0, 0) }, "skipped_other"],
];

function scanLines(write: { mock: { calls: unknown[][] } }) {
  return write.mock.calls.map(call => JSON.parse(String(call[0]).trim()) as Record<string, unknown>)
    .filter(event => event.event === "calendar_autojoin_scan");
}

describe("calendar scan classification and shipped counts", () => {
  test("classification agrees with eligibility and Meet parsing across closed skip reasons", () => {
    for (const [event, reason] of cases) {
      const eligible = eligibleCalendarEvent(event);
      const meet = calendarMeetEvent(event);
      const classification = classifyCalendarScanEvent(event, eligible, meet);
      expect(classification).toBe(reason);
      if (reason === "eligible") expect(eligible).toEqual(meet);
      else if (reason === "skipped_not_accepted") { expect(eligible).toBeNull(); expect(meet).not.toBeNull(); }
      else if (reason !== "skipped_other") { expect(eligible).toBeNull(); expect(meet).toBeNull(); }
    }
    expect(classifyCalendarScanEvent(null as never, null, null)).toBe("skipped_other");
    expect(classifyCalendarScanEvent({ id: "odd" } as GoogleCalendarEvent, null, null)).toBe("skipped_other");
  });

  test("a scan counts rowless ineligible events, deduplicates steady counts and reports failures", async () => {
    configureRequestLogAccountHash("test-only-calendar-log-hmac-key-with-enough-entropy-0123456789");
    const store = new MemoryCalendarAutojoinStore();
    let now = start - 600_000;
    const events = cases.map(([event]) => event);
    for (const address of [tenant, `${tenant}-second`]) {
      await store.putConnection({ tenant: address, subject: "subject", state: "enabled", generation: 1,
        scopes: [], nextScanAt: 0, scanComplete: false });
    }
    let failed = false;
    const worker = new CalendarAutojoinWorker({ store, coordinator: new TenantCoordinator(),
      calendar: { async listEvents() { if (failed) throw new Error("GOOGLE_CANARY_PRIVATE"); return events; },
        async getEvent() { return null; }, async probePrimary() {} },
      connection: { async cleanupEnabling() {}, async accessToken() { return "test-token"; }, async needsReconnect() {} },
      api: null as never, index: null as never, now: () => now, random: () => 0 });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker.tick();
      expect(scanLines(write)).toEqual([{ event: "calendar_autojoin_scan",
        listed: 16, eligible: 2, skipped_not_confirmed: 2, skipped_not_timed: 4, skipped_no_meet_link: 2,
        skipped_not_accepted: 4, skipped_other: 2, scan_complete: true }]);
      const text = JSON.stringify(scanLines(write));
      for (const privateText of [tenant.toLowerCase(), "PRIVATE_TITLE", "private-event-id", "meet.google.com", "needsAction"])
        expect(text).not.toContain(privateText);
      expect(text).not.toContain("tenant_hash");
      write.mockClear();
      for (const address of [tenant, `${tenant}-second`])
        await store.updateConnection(address, row => row && { ...row, nextScanAt: 0 });
      now += 30_000;
      await worker.tick();
      expect(scanLines(write)).toEqual([]);
      write.mockClear();
      for (const address of [tenant, `${tenant}-second`])
        await store.updateConnection(address, row => row && { ...row, nextScanAt: 0 });
      now += 300_000;
      await worker.tick();
      expect(scanLines(write)).toHaveLength(1);
      failed = true;
      write.mockClear();
      for (const address of [tenant, `${tenant}-second`])
        await store.updateConnection(address, row => row && { ...row, nextScanAt: 0 });
      await worker.tick();
      expect(scanLines(write)).toEqual([expect.objectContaining({ listed: 0, scan_complete: false })]);
      write.mockClear();
      for (const address of [tenant, `${tenant}-second`])
        await store.updateConnection(address, row => row && { ...row, nextScanAt: 0 });
      await worker.tick();
      expect(scanLines(write)).toEqual([expect.objectContaining({ listed: 0, scan_complete: false })]);
    } finally { write.mockRestore(); log.mockRestore(); configureRequestLogAccountHash(undefined); await worker.stop(); }
  });
});
