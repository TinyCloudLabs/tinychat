import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { transcriptKvKey, upsertMeeting, type NormalizedMeeting } from "../../frontend/src/lib/connectors/connectorStore";

const sentence = (index: number) => ({
  index,
  speaker_name: "Ada",
  text: ["one", "two", "three"][index]!,
  start_time: index,
  end_time: index + 1,
});

test("a fuller Meet re-sweep conditionally replaces the transcript once and an unchanged replay writes nothing", async () => {
  const sqlite = new Database(":memory:");
  const bodies = new Map<string, { body: string; etag: string }>();
  const puts: { ifNoneMatch?: string; ifMatch?: string }[] = [];
  let revision = 0;
  const tcw = {
    did: `did:test:meet-repair-${crypto.randomUUID()}`,
    sql: { db: () => ({
      query: async (sql: string, params: unknown[] = []) => ({
        ok: true, data: { rows: sqlite.query(sql).values(...(params as never[])) },
      }),
      execute: async (sql: string, params: unknown[] = []) => ({
        ok: true, data: { changes: sqlite.query(sql).run(...(params as never[])).changes },
      }),
    }) },
    kv: {
      get: async (key: string) => {
        const entry = bodies.get(key);
        return entry
          ? { ok: true, data: { data: entry.body, headers: { etag: entry.etag } } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
      },
      put: async (key: string, body: string, options: { ifNoneMatch?: string; ifMatch?: string } = {}) => {
        puts.push(options);
        const current = bodies.get(key);
        if ((options.ifNoneMatch === "*" && current) || (options.ifMatch && current?.etag !== options.ifMatch)) {
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED", message: "changed" } };
        }
        bodies.set(key, { body, etag: String(++revision) });
        return { ok: true, data: { data: undefined, headers: {} } };
      },
    },
  } as unknown as TinyCloudWeb;
  const meeting: NormalizedMeeting = {
    id: "candidate-not-stored",
    source: "google-meet",
    sourceId: "conference-1",
    title: "Standup",
    startedAt: "2026-10-16T09:00:00.000Z",
    durationSecs: 90,
    organizerEmail: null,
    participants: [],
    summaryOverview: null,
    summaryActionItems: null,
    keywords: null,
    meetingType: null,
    metadata: { entry_count: 1 },
  };
  const key = transcriptKvKey(meeting.source, meeting.sourceId);
  try {
    const initial = await upsertMeeting(tcw, meeting, [sentence(0)]);
    expect(initial.ok).toBe(true);
    const fuller = { ...meeting, metadata: { entry_count: 3 } };
    const complete = [sentence(0), sentence(1), sentence(2)];
    const repaired = await upsertMeeting(tcw, fuller, complete);
    expect(repaired.ok).toBe(true);
    expect(sqlite.query("SELECT id FROM connector_meeting").values()).toHaveLength(1);
    expect(bodies.get(key)?.body).toBe(JSON.stringify(complete));
    expect(puts).toEqual([{ ifNoneMatch: "*" }, { ifMatch: "1" }]);

    const unchanged = await upsertMeeting(tcw, fuller, complete);
    expect(unchanged.ok).toBe(true);
    expect(puts).toHaveLength(2);
  } finally {
    sqlite.close();
  }
});
