import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  connectorMeetingId,
  firefliesMeetingKvKey,
  transcriptKvKey,
} from "@tinyboilerplate/core";

import { beginStorageAccountSession, endStorageAccountSession } from "@/lib/storageStatus";
import { resetLanesForTests } from "@/lib/localFirst/requestLanes";
import { useLibrary, type Library } from "./useLibrary";

const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  fetch: globalThis.fetch,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    setTimeout,
    clearTimeout,
    event: undefined,
    HTMLIFrameElement: class {},
  };
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
  globalThis.fetch = saved.fetch;
});

let spaceSeq = 0;

function makeKvHeaders(lastModified: string) {
  return {
    lastModified,
    contentType: "application/json",
    get: (name: string) => (name.toLowerCase() === "last-modified" ? lastModified : null),
  };
}

async function makeMeetingPayload(sourceId: string, title: string): Promise<string> {
  const id = await connectorMeetingId("fireflies", sourceId);
  return JSON.stringify({
    id,
    source: "fireflies",
    sourceId,
    title,
    // Planted future timestamps to prove purge checks never read JSON body timestamps.
    startedAt: "2099-01-01T00:00:00.000Z",
    importedAt: "2099-01-02T00:00:00.000Z",
    durationSecs: 900,
    participants: [{ name: "Jordan", email: "jordan@example.com" }],
    summaryOverview: "Quarterly planning summary.",
    hasTranscript: true,
    hasSummary: true,
    origin: "fireflies-delegation-import",
  });
}

function makeFakeSessionStore(token = "test-session-token"): SessionStore {
  return {
    getToken: () => token,
    isExpired: () => false,
    clear: async () => undefined,
  } as unknown as SessionStore;
}

function makeFakeTcw(kvEntries: Record<string, { data: string; lastModified: string }>) {
  spaceSeq += 1;
  const kvListCalls: Array<{ prefix?: string; limit?: number }> = [];
  const kvGetCalls: string[] = [];

  const tcw = {
    did: `did:test:fireflies-library-${spaceSeq}`,
    spaceId: `fireflies-library-${spaceSeq}`,
    sql: {
      db: () => ({
        query: async (sql: string) => {
          if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: [] } };
          return {
            ok: false,
            error: { code: "NOT_FOUND", message: "no such table: connector_meeting" },
          };
        },
      }),
    },
    kv: {
      list: async (opts?: { prefix?: string; limit?: number }) => {
        kvListCalls.push({ prefix: opts?.prefix, limit: opts?.limit });
        const prefix = opts?.prefix ?? "";
        const keys = Object.keys(kvEntries).filter((k) => k.startsWith(prefix));
        return { ok: true, data: { keys } };
      },
      get: async (key: string) => {
        kvGetCalls.push(key);
        const entry = kvEntries[key];
        if (!entry) {
          return { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
        }
        return {
          ok: true,
          data: {
            data: entry.data,
            headers: makeKvHeaders(entry.lastModified),
          },
        };
      },
    },
  } as unknown as TinyCloudWeb;

  beginStorageAccountSession(tcw, tcw.did ?? null, tcw.spaceId ?? null);
  return { tcw, kvListCalls, kvGetCalls };
}

interface ProbeProps {
  tcw: TinyCloudWeb;
  visible: boolean;
  noteId: string | null;
  backendUrl?: string;
  sessionStore?: SessionStore;
  seen: Library[];
}

function Probe(props: ProbeProps) {
  props.seen.push(
    useLibrary(props.tcw, {
      visible: props.visible,
      noteId: props.noteId,
      backendUrl: props.backendUrl,
      sessionStore: props.sessionStore,
    }),
  );
  return null;
}

const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  ownerDocument: null,
  textContent: "",
  addEventListener() {},
  removeEventListener() {},
} as unknown as HTMLElement;

let root: Root | null = null;

async function renderProbe(props: ProbeProps) {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(<Probe {...props} />);
  });
}

async function waitFor(predicate: () => boolean, label: string, maxTicks = 60) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  globalThis.fetch = saved.fetch;
  endStorageAccountSession();
  resetLanesForTests();
});

describe("useLibrary Fireflies KV production wiring", () => {
  test("wires backendUrl + sessionStore purge checks across list, metadata and transcript reads", async () => {
    const backendUrl = "https://backend.example";
    const liveId = await connectorMeetingId("fireflies", "ff-live");
    const turnsPurgedId = await connectorMeetingId("fireflies", "ff-turns-purged");

    const purgedMetaTs = "2026-11-22T10:00:00.000Z";
    const liveMetaTs = "2026-11-22T15:00:00.000Z";
    const liveTranscriptTs = "2026-11-22T15:01:00.000Z";
    const turnsPurgedMetaTs = "2026-11-22T16:00:00.000Z";
    const turnsPurgedTranscriptTs = "2026-11-22T16:01:00.000Z";

    const { tcw, kvListCalls, kvGetCalls } = makeFakeTcw({
      [firefliesMeetingKvKey("ff-purged")]: {
        data: await makeMeetingPayload("ff-purged", "Purged Fireflies Meeting"),
        lastModified: purgedMetaTs,
      },
      [transcriptKvKey("fireflies", "ff-purged")]: {
        data: JSON.stringify([
          { index: 0, speaker_name: "Alice", text: "Purged transcript line.", start_time: 0, end_time: 3 },
        ]),
        lastModified: "2026-11-22T10:01:00.000Z",
      },
      [firefliesMeetingKvKey("ff-live")]: {
        data: await makeMeetingPayload("ff-live", "Live Fireflies Meeting"),
        lastModified: liveMetaTs,
      },
      [transcriptKvKey("fireflies", "ff-live")]: {
        data: JSON.stringify([
          { index: 0, speaker_name: "Jordan", text: "Live transcript body.", start_time: 0, end_time: 4 },
        ]),
        lastModified: liveTranscriptTs,
      },
      [firefliesMeetingKvKey("ff-turns-purged")]: {
        data: await makeMeetingPayload("ff-turns-purged", "Purged Before Open"),
        lastModified: turnsPurgedMetaTs,
      },
      [transcriptKvKey("fireflies", "ff-turns-purged")]: {
        data: JSON.stringify([
          { index: 0, speaker_name: "Sam", text: "Must stay hidden once purged.", start_time: 0, end_time: 5 },
        ]),
        lastModified: turnsPurgedTranscriptTs,
      },
    });

    const purgedIds = new Set<string>(["ff-purged"]);
    const purgeRequests: Array<{
      meetingId: string;
      sourceTimestamp: string | null;
      source?: string;
      auth: string | null;
      csrf: string | null;
    }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${backendUrl}/api/server-info`) {
        return new Response(
          JSON.stringify({ capabilities: { firefliesServerImport: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${backendUrl}/api/connectors/webhooks/purge-check`) {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          meetingId: string;
          sourceTimestamp: string | null;
          source?: string;
        };
        purgeRequests.push({
          meetingId: body.meetingId,
          sourceTimestamp: body.sourceTimestamp,
          source: body.source,
          auth: headers.get("authorization"),
          csrf: headers.get("x-requested-with"),
        });
        return new Response(
          JSON.stringify({ blocked: purgedIds.has(body.meetingId) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const sessionStore = makeFakeSessionStore("session-jwt-123");
    const seen: Library[] = [];

    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });

    await waitFor(
      () => {
        const latest = seen.at(-1);
        return Boolean(latest && latest.status === "ready" && !latest.listing && latest.items.length === 2);
      },
      "list phase discovers live KV meetings and hides purged meeting",
    );

    const listedIds = seen.at(-1)!.items.map((item) => item.id).sort();
    expect(listedIds).toEqual([liveId, turnsPurgedId].sort());
    expect(seen.at(-1)!.items.every((item) => item.importSource === "server-import")).toBe(true);
    expect(kvListCalls.length).toBeGreaterThanOrEqual(1);

    // Every list-phase purge check carried auth, CSRF, and node lastModified (never planted 2099 timestamps).
    expect(purgeRequests.some((r) => r.meetingId === "ff-purged" && r.sourceTimestamp === purgedMetaTs)).toBe(true);
    expect(purgeRequests.some((r) => r.meetingId === "ff-live" && r.sourceTimestamp === liveMetaTs)).toBe(true);
    expect(purgeRequests.every((r) => r.auth === "Bearer session-jwt-123" && r.csrf === "XMLHttpRequest" && r.source === "fireflies")).toBe(true);
    expect(purgeRequests.every((r) => r.sourceTimestamp !== "2099-01-01T00:00:00.000Z")).toBe(true);

    const purgeCountBeforeOpen = purgeRequests.length;

    // Open the live KV meeting: both metadata AND transcript reads must pass through the purge checker.
    await renderProbe({ tcw, visible: true, noteId: liveId, backendUrl, sessionStore, seen });

    await waitFor(
      () => {
        const reads = seen.at(-1)?.note.reads;
        return reads?.metadata?.status === "ok" && reads?.transcript?.transcript.status === "ok";
      },
      "open live KV meeting loads metadata and transcript through purge checker",
    );

    const liveReads = seen.at(-1)!.note.reads;
    expect(liveReads.metadata).toMatchObject({
      status: "ok",
      metadata: {
        import_source: "server-import",
        origin: "fireflies-delegation-import",
        has_summary: true,
        has_transcript: true,
      },
    });
    expect(liveReads.transcript?.transcript).toEqual({
      status: "ok",
      sentences: [{ index: 0, speaker_name: "Jordan", text: "Live transcript body.", start_time: 0, end_time: 4 }],
    });

    const openLiveChecks = purgeRequests.slice(purgeCountBeforeOpen).filter((r) => r.meetingId === "ff-live");
    expect(openLiveChecks.some((r) => r.sourceTimestamp === liveMetaTs)).toBe(true);
    expect(openLiveChecks.some((r) => r.sourceTimestamp === liveTranscriptTs)).toBe(true);

    // Now mark the second listed meeting purged BEFORE opening it: metadata AND transcript must both be absent.
    purgedIds.add("ff-turns-purged");
    const purgeCountBeforePurgedOpen = purgeRequests.length;
    await renderProbe({ tcw, visible: true, noteId: turnsPurgedId, backendUrl, sessionStore, seen });

    await waitFor(
      () => {
        const reads = seen.at(-1)?.note.reads;
        return reads?.metadata?.status === "absent" && reads?.transcript?.transcript.status === "absent";
      },
      "newly purged KV meeting hides metadata and transcript on open",
    );

    const purgedOpenChecks = purgeRequests
      .slice(purgeCountBeforePurgedOpen)
      .filter((r) => r.meetingId === "ff-turns-purged");
    expect(purgedOpenChecks.some((r) => r.sourceTimestamp === turnsPurgedMetaTs)).toBe(true);
    expect(purgedOpenChecks.some((r) => r.sourceTimestamp === turnsPurgedTranscriptTs)).toBe(true);
    expect(kvGetCalls).toContain(firefliesMeetingKvKey("ff-live"));
    expect(kvGetCalls).toContain(transcriptKvKey("fireflies", "ff-live"));
  });

  test("fails closed with zero KV rows and zero KV calls when backendUrl and sessionStore are omitted", async () => {
    const { tcw, kvListCalls, kvGetCalls } = makeFakeTcw({
      [firefliesMeetingKvKey("ff-hidden")]: {
        data: await makeMeetingPayload("ff-hidden", "Must Not Appear"),
        lastModified: "2026-11-22T15:00:00.000Z",
      },
    });

    const seen: Library[] = [];
    await renderProbe({ tcw, visible: true, noteId: null, seen });

    await waitFor(
      () => {
        const latest = seen.at(-1);
        return Boolean(latest && latest.status === "ready" && !latest.listing);
      },
      "list settles with neither backendUrl nor sessionStore",
    );

    expect(seen.at(-1)!.items).toEqual([]);
    expect(kvListCalls).toEqual([]);
    expect(kvGetCalls).toEqual([]);
  });

  test("fails closed with zero KV rows and zero KV calls when capability is on but sessionStore is absent", async () => {
    const backendUrl = "https://backend.example";
    let serverInfoCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${backendUrl}/api/server-info`) {
        serverInfoCalls += 1;
        return new Response(
          JSON.stringify({ capabilities: { firefliesServerImport: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { tcw, kvListCalls, kvGetCalls } = makeFakeTcw({
      [firefliesMeetingKvKey("ff-no-session")]: {
        data: await makeMeetingPayload("ff-no-session", "Must Not Appear Without Session"),
        lastModified: "2026-11-22T15:00:00.000Z",
      },
    });

    const seen: Library[] = [];
    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, seen });

    await waitFor(
      () => {
        const latest = seen.at(-1);
        return Boolean(serverInfoCalls >= 1 && latest && latest.status === "ready" && !latest.listing);
      },
      "list settles with capability on and no sessionStore",
    );

    // Allow any re-refresh triggered by server-info capability update to settle too.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(seen.at(-1)!.items).toEqual([]);
    expect(kvListCalls).toEqual([]);
    expect(kvGetCalls).toEqual([]);
  });
});
