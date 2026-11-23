import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_KV_PREFIX, meetingKvKey, transcriptKvKey } from "../connectors/connectorStore";
import { USER_SPACE_MEETING_VERSION } from "../connectors/backendReconcile";
import { discoverKvMeetings, discoverMeetingCorpus } from "./corpus";
import { createBrowserMeetingTurnRetriever, readMeetingEvidence } from "./retriever";
import type { MeetingCandidate } from "./types";

function kvHeaders(lastModified: string) {
  return {
    lastModified,
    get: (name: string) => (name.toLowerCase() === "last-modified" ? lastModified : null),
  };
}

function makeCandidate(overrides: Partial<MeetingCandidate> = {}): MeetingCandidate {
  return {
    source: "fireflies",
    sourceId: "ff-1",
    title: "Weekly Sync",
    startedAt: "2026-11-22T15:00:00.000Z",
    participantNames: ["Jordan"],
    participantEmails: ["jordan@example.com"],
    organizerEmail: "host@example.com",
    hasSqlSummary: false,
    hasLocalRecord: true,
    hasLocalTranscript: true,
    hasServerSummary: false,
    hasServerTranscript: false,
    localRowId: null,
    createdAt: "2026-11-22T15:00:00.000Z",
    updatedAt: "2026-11-22T15:00:00.000Z",
    ...overrides,
  };
}

describe("meetingChat Fireflies KV gate and sdk-services paging (TC-3919)", () => {
  test("makes zero KV calls when Fireflies server import flag is OFF or purge checker is absent", async () => {
    const kvListCalls: unknown[] = [];
    const kvGetCalls: string[] = [];
    const tcw = {
      sql: {
        db: () => ({
          query: async (sql: string) =>
            sql.includes("FROM connector_meeting")
              ? { ok: false, error: { message: "no such table: connector_meeting" } }
              : { ok: true, data: { rows: [] } },
        }),
      },
      kv: {
        list: async (opts: unknown) => {
          kvListCalls.push(opts);
          return { ok: true, data: { keys: [meetingKvKey("fireflies", "ff-off")] } };
        },
        get: async (key: string) => {
          kvGetCalls.push(key);
          return {
            ok: true,
            data: {
              data: [{ index: 0, speaker_name: "A", text: "Must not read", start_time: 0, end_time: 2 }],
              headers: kvHeaders("2026-11-22T15:00:00.000Z"),
            },
          };
        },
      },
    } as unknown as Pick<TinyCloudWeb, "kv" | "sql">;

    const meetings = {
      list: async () => ({
        status: "ok" as const,
        value: {
          source: "fireflies",
          meetings: [
            {
              sourceId: "ff-off",
              title: "Planning",
              ts: "2026-11-22T15:00:00.000Z",
              storedAt: "2026-11-22T15:00:00.000Z",
              updatedAt: "2026-11-22T15:00:00.000Z",
              hasSummary: false,
              hasTranscript: false,
              sizeBytes: 1,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      }),
      read: async () => ({ status: "not-found" as const }),
    };

    // 1. Flag OFF via createBrowserMeetingTurnRetriever -> zero KV list or get calls.
    const retrieverOff = createBrowserMeetingTurnRetriever({
      tcw,
      meetings,
      firefliesKv: { enabled: false, isFirefliesPurged: async () => false },
    });
    const outcomeOff = await retrieverOff.retrieve({ threadId: "t1", question: "latest meeting notes" });
    expect(outcomeOff.status).toBe("no-content");
    expect(kvListCalls).toEqual([]);
    expect(kvGetCalls).toEqual([]);

    // 2. Flag ON without purge checker -> fails closed with zero KV calls.
    const corpusNoChecker = await discoverMeetingCorpus(tcw, meetings, "fireflies", undefined, null, {
      firefliesKv: { enabled: true },
    });
    expect(corpusNoChecker.candidates.every((c) => !c.hasLocalRecord && !c.hasLocalTranscript)).toBe(true);
    const evidenceNoChecker = await readMeetingEvidence(makeCandidate({ sourceId: "ff-off" }), {
      tcw,
      meetings,
      firefliesKv: { enabled: true },
    });
    expect(evidenceNoChecker.status).toBe("no-content");
    expect(kvListCalls).toEqual([]);
    expect(kvGetCalls).toEqual([]);
  });

  test("blocks purged Fireflies KV summaries and transcripts while serving live ones using node lastModified", async () => {
    const recordTs = "2026-11-22T15:00:00.000Z";
    const transcriptTs = "2026-11-22T15:01:00.000Z";
    const purgedIds = new Set<string>(["ff-purged"]);
    const purgeChecks: Array<{ meetingId: string; writtenAt?: string }> = [];

    const kvData: Record<string, { data: unknown; lastModified: string }> = {
      [meetingKvKey("fireflies", "ff-purged")]: {
        data: {
          v: USER_SPACE_MEETING_VERSION,
          source: "fireflies",
          sourceId: "ff-purged",
          hasSummary: true,
          hasTranscript: true,
          summary: { overview: "PURGED SUMMARY CANARY" },
        },
        lastModified: recordTs,
      },
      [transcriptKvKey("fireflies", "ff-purged")]: {
        data: [{ index: 0, speaker_name: "Alice", text: "PURGED TRANSCRIPT CANARY", start_time: 0, end_time: 3 }],
        lastModified: transcriptTs,
      },
      [meetingKvKey("fireflies", "ff-live")]: {
        data: {
          v: USER_SPACE_MEETING_VERSION,
          source: "fireflies",
          sourceId: "ff-live",
          hasSummary: true,
          hasTranscript: true,
          summary: { overview: "LIVE SUMMARY OK" },
        },
        lastModified: recordTs,
      },
      [transcriptKvKey("fireflies", "ff-live")]: {
        data: [{ index: 0, speaker_name: "Jordan", text: "LIVE TRANSCRIPT OK", start_time: 0, end_time: 3 }],
        lastModified: transcriptTs,
      },
    };

    const tcw = {
      sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }) }) },
      kv: {
        get: async (key: string) => {
          const entry = kvData[key];
          if (!entry) return { ok: false, error: { code: "KV_NOT_FOUND" } };
          return { ok: true, data: { data: entry.data, headers: kvHeaders(entry.lastModified) } };
        },
      },
    } as unknown as Pick<TinyCloudWeb, "kv" | "sql">;
    const meetings = { read: async () => ({ status: "not-found" as const }) };

    const isFirefliesPurged = async (meetingId: string, writtenAt?: string) => {
      purgeChecks.push({ meetingId, writtenAt });
      return purgedIds.has(meetingId);
    };

    // Purged meeting: neither summary nor transcript may surface.
    const purgedOutcome = await readMeetingEvidence(makeCandidate({ sourceId: "ff-purged" }), {
      tcw,
      meetings,
      requireTranscript: true,
      firefliesKv: { enabled: true, isFirefliesPurged },
    });
    expect(purgedOutcome.status).toBe("no-content");
    expect(JSON.stringify(purgedOutcome)).not.toContain("PURGED");
    expect(purgeChecks).toEqual([
      { meetingId: "ff-purged", writtenAt: recordTs },
      { meetingId: "ff-purged", writtenAt: transcriptTs },
    ]);

    // Live meeting: both summary and transcript surface cleanly.
    const liveOutcome = await readMeetingEvidence(makeCandidate({ sourceId: "ff-live" }), {
      tcw,
      meetings,
      requireTranscript: true,
      firefliesKv: { enabled: true, isFirefliesPurged },
    });
    expect(liveOutcome.status).toBe("evidence");
    if (liveOutcome.status !== "evidence") throw new Error("expected evidence");
    expect(liveOutcome.evidence.summary).toContain("LIVE SUMMARY OK");
    expect(JSON.stringify(liveOutcome.evidence.transcript)).toContain("LIVE TRANSCRIPT OK");

    // Throwing purge checker fails closed.
    const errorOutcome = await readMeetingEvidence(makeCandidate({ sourceId: "ff-live" }), {
      tcw,
      meetings,
      requireTranscript: true,
      firefliesKv: {
        enabled: true,
        isFirefliesPurged: async () => {
          throw new Error("ledger unavailable");
        },
      },
    });
    expect(errorOutcome.status).toBe("no-content");
  });

  test("follows sdk-services nextCursor across pages and marks lane truncated from data.truncated", async () => {
    const meetingPrefix = `${CONNECTORS_KV_PREFIX}/fireflies/meeting/`;
    const transcriptPrefix = `${CONNECTORS_KV_PREFIX}/fireflies/transcript/`;
    const calls: Array<{ path: string; cursor?: string }> = [];

    const pagedTcw = {
      kv: {
        list: async (opts: { path: string; cursor?: string }) => {
          calls.push({ path: opts.path, cursor: opts.cursor });
          if (opts.path === meetingPrefix && opts.cursor === undefined) {
            return { ok: true, data: { keys: [`${meetingPrefix}m1`], nextCursor: "p2", truncated: true } };
          }
          if (opts.path === meetingPrefix && opts.cursor === "p2") {
            return { ok: true, data: { keys: [`${meetingPrefix}m2`], truncated: false } };
          }
          if (opts.path === transcriptPrefix) {
            return { ok: true, data: { keys: [`${transcriptPrefix}m1`], truncated: true } };
          }
          return { ok: true, data: { keys: [] } };
        },
      },
    } as unknown as Pick<TinyCloudWeb, "kv">;

    const result = await discoverKvMeetings(pagedTcw, "fireflies", undefined, {
      firefliesKv: { enabled: true, isFirefliesPurged: async () => false },
    });

    expect(calls).toEqual([
      { path: meetingPrefix, cursor: undefined },
      { path: meetingPrefix, cursor: "p2" },
      { path: transcriptPrefix, cursor: undefined },
    ]);
    expect(result.candidates.map((c) => c.sourceId)).toEqual(["m1", "m2"]);
    expect(result.lane).toEqual({ state: "partial", malformedRows: 0, truncated: true });
  });
});
