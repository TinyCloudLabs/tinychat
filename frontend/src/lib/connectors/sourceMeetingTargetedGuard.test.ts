import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ingestQueuedMeetings, type TargetedIngestStore } from "./targetedSync";
import type { ConnectorDescriptor } from "./types";

const descriptor: ConnectorDescriptor = {
  id: "fireflies", name: "Fireflies", description: "test", status: "available",
  secretName: "API_KEY", secretScope: "fireflies", source: "fireflies",
};
const tcw = {} as TinyCloudWeb;
const ok = <T>(data: T) => ({ ok: true as const, data });

function fixture(mode: "marked" | "offline" | "late") {
  const calls: string[] = [];
  const store = {
    async isMeetingDeleted() {
      calls.push("marker");
      return mode === "offline"
        ? { ok: false as const, error: { code: "KV_ERROR", message: "marker unavailable" } }
        : ok(mode === "marked");
    },
    async upsertMeeting() {
      calls.push("upsert");
      return mode === "late"
        ? { ok: false as const, error: { code: "SOURCE_MEETING_DELETED", message: "deleted during write" } }
        : ok({ id: "row-1", inserted: true, createdAt: "now" });
    },
    async countMeetings() { return ok(0); },
    async updateSyncState() { return ok(undefined); },
  } as TargetedIngestStore;
  const webhooks = {
    async acknowledge(request: { items: unknown[] }) {
      calls.push("ack");
      return { status: "ok" as const, value: {
        status: "acknowledged" as const, acknowledged: request.items.length,
        alreadySettled: 0, tombstoned: 0, enabled: true, disabledAt: null,
        source: "fireflies" as const, deliveriesRateLimited: false, count: 0,
        pending: [], deadCount: 0, dead: [],
      } };
    },
  };
  return {
    calls,
    run: () => ingestQueuedMeetings({
      tcw, descriptor, items: [{ meetingId: "meeting-1", kind: "transcript" }],
      webhooks, store,
      secrets: { isUnlocked: () => true, async getKey() { return ok("secret"); } },
      createClient: () => ({ delayMs: 0, async getTranscript() { return ok({
        id: "meeting-1", title: "Weekly", date: "2026-08-16T09:00:00.000Z", duration: 30,
        organizer_email: null, speakers: [], meeting_attendees: [], sentences: [], summary: null,
      }); } }),
    }),
  };
}

describe("targeted Fireflies deletion marker", () => {
  test("marked ids are skipped and acknowledged without writes", async () => {
    const f = fixture("marked");
    const result = await f.run();
    expect(result.ok && result.data.skipped).toBe(1);
    expect(result.ok && result.data.acknowledged).toBe(1);
    expect(f.calls).toEqual(["marker", "ack"]);
  });
  test("unreadable marker leaves queued identity unacknowledged and unwritten", async () => {
    const f = fixture("offline");
    const result = await f.run();
    expect(result.ok && result.data.failures).toHaveLength(1);
    expect(result.ok && result.data.acknowledged).toBe(0);
    expect(f.calls).toEqual(["marker"]);
  });
  test("a marker appearing inside the upsert also skips and acknowledges", async () => {
    const f = fixture("late");
    const result = await f.run();
    expect(result.ok && result.data.skipped).toBe(1);
    expect(f.calls).toEqual(["marker", "upsert", "ack"]);
  });
});
