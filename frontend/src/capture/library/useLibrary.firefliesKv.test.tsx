import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  connectorMeetingId,
  firefliesMeetingKvKey,
  transcriptKvKey,
} from "@tinyboilerplate/core";

import { accountCacheKey, readLocal, writeLocal } from "@/lib/localFirst/localCache";
import { runOnSpace } from "@/lib/spaceQueue";
import { beginStorageAccountSession, endStorageAccountSession } from "@/lib/storageStatus";
import { resetLanesForTests } from "@/lib/localFirst/requestLanes";
import { useLibrary, type Library } from "./useLibrary";

const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  fetch: globalThis.fetch,
};

const windowEvents = new EventTarget();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (import.meta.env as Record<string, unknown>).VITE_FIREFLIES_SERVER_IMPORT_ENABLED = "true";
  (globalThis as { window?: unknown }).window = {
    setTimeout,
    clearTimeout,
    event: undefined,
    HTMLIFrameElement: class {},
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
  };
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
  globalThis.fetch = saved.fetch;
  delete (import.meta.env as Record<string, unknown>).VITE_FIREFLIES_SERVER_IMPORT_ENABLED;
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

  test("filters cached server-imported rows out of local cache read/write and never forces KV opt-in when flag is off", async () => {
    const savedIdb = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    try {
      const cachedImportedId = await connectorMeetingId("fireflies", "ff-cached-old");
      const sqlRowId = "sql-kept-1";
      const did = "did:test:fireflies-cache-isolation";
      const localKey = accountCacheKey(did, "library");

      await writeLocal(localKey, {
        items: [
          {
            id: cachedImportedId,
            source: "fireflies",
            importSource: "server-import",
            sourceId: "ff-cached-old",
            title: "Stale Cached Server Import",
            startedAt: "2026-11-20T10:00:00.000Z",
            durationSecs: 600,
            metadata: { import_source: "server-import" },
          },
          {
            id: sqlRowId,
            source: "fireflies",
            sourceId: "ff-sql-1",
            title: "Cached Browser SQL Row",
            startedAt: "2026-11-20T09:00:00.000Z",
            durationSecs: 300,
          },
        ],
        previews: new Map<string, string>(),
      });

      const kvListCalls: unknown[] = [];
      const kvGetCalls: string[] = [];
      let releaseList!: () => void;
      const listGate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      const tcw = {
        did,
        spaceId: "fireflies-cache-isolation",
        sql: {
          db: () => ({
            query: async (sql: string) => {
              if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: [] } };
              await listGate;
              return {
                ok: true,
                data: {
                  rows: [[sqlRowId, "fireflies", "ff-sql-1", "Cached Browser SQL Row", "2026-11-20T09:00:00.000Z", 300]],
                },
              };
            },
          }),
        },
        kv: {
          list: async (opts: unknown) => {
            kvListCalls.push(opts);
            return { ok: true, data: { keys: [firefliesMeetingKvKey("ff-cached-old")] } };
          },
          get: async (key: string) => {
            kvGetCalls.push(key);
            return {
              ok: true,
              data: {
                data: await makeMeetingPayload("ff-cached-old", "Stale Cached Server Import"),
                headers: makeKvHeaders("2026-11-20T10:00:00.000Z"),
              },
            };
          },
        },
      } as unknown as TinyCloudWeb;
      beginStorageAccountSession(tcw, tcw.did ?? null, tcw.spaceId ?? null);

      const seen: Library[] = [];
      // 1. Flag is OFF (no backendUrl): pre-seeded cache loads before network finishes.
      await renderProbe({ tcw, visible: true, noteId: cachedImportedId, seen });

      await waitFor(
        () => seen.some((lib) => lib.status === "ready" && lib.items.some((i) => i.id === sqlRowId)),
        "local cache hydrates non-imported SQL row",
      );

      // Cached server-imported row MUST NEVER appear before a live flag + purge verdict, and opening its ID makes zero KV calls.
      expect(seen.every((lib) => lib.items.every((i) => i.id !== cachedImportedId))).toBe(true);
      expect(seen.at(-1)!.note.item).toBeNull();
      expect(kvListCalls).toEqual([]);
      expect(kvGetCalls).toEqual([]);

      // 2. Flag is ON (backendUrl + sessionStore) while network list is still pending: pre-seeded
      //    cached server-imported row MUST STILL NEVER render before a fresh purge verdict lands.
      const backendUrlForGate = "https://backend-gate.example";
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === `${backendUrlForGate}/api/server-info`) {
          return new Response(JSON.stringify({ capabilities: { firefliesServerImport: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === `${backendUrlForGate}/api/connectors/webhooks/purge-check`) {
          return new Response(JSON.stringify({ blocked: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      await act(async () => {
        root!.unmount();
      });
      root = null;
      const seenGateOn: Library[] = [];
      await renderProbe({
        tcw,
        visible: true,
        noteId: cachedImportedId,
        backendUrl: backendUrlForGate,
        sessionStore: makeFakeSessionStore(),
        seen: seenGateOn,
      });
      await waitFor(
        () => seenGateOn.some((lib) => lib.status === "ready" && lib.items.some((i) => i.id === sqlRowId)),
        "local cache hydrates SQL row while ON network list is pending",
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(seenGateOn.every((lib) => lib.items.every((i) => i.id !== cachedImportedId))).toBe(true);
      expect(seenGateOn.at(-1)!.note.item).toBeNull();

      releaseList();
      await waitFor(
        () => Boolean(seenGateOn.at(-1) && !seenGateOn.at(-1)!.listing),
        "network list finishes",
      );
      expect(seenGateOn.at(-1)!.items.every((i) => i.id !== cachedImportedId)).toBe(true);

      // Now verify writeLocal also excludes server-imported rows after an ON network list.
      const backendUrl = "https://backend.example";
      const liveId = await connectorMeetingId("fireflies", "ff-live-nocache");
      const kvEntries: Record<string, { data: string; lastModified: string }> = {
        [firefliesMeetingKvKey("ff-live-nocache")]: {
          data: await makeMeetingPayload("ff-live-nocache", "Live Imported Row"),
          lastModified: "2026-11-22T15:00:00.000Z",
        },
      };
      const tcwOn = {
        did: "did:test:fireflies-nocache-write",
        spaceId: "fireflies-nocache-write",
        sql: {
          db: () => ({
            query: async (sql: string) => {
              if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: [] } };
              return {
                ok: true,
                data: {
                  rows: [[sqlRowId, "fireflies", "ff-sql-1", "SQL Row", "2026-11-22T10:00:00.000Z", 100]],
                },
              };
            },
          }),
        },
        kv: {
          list: async () => ({ ok: true, data: { keys: Object.keys(kvEntries) } }),
          get: async (key: string) => ({
            ok: true,
            data: { data: kvEntries[key]!.data, headers: makeKvHeaders(kvEntries[key]!.lastModified) },
          }),
        },
      } as unknown as TinyCloudWeb;
      beginStorageAccountSession(tcwOn, tcwOn.did ?? null, tcwOn.spaceId ?? null);

      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === `${backendUrl}/api/server-info`) {
          return new Response(JSON.stringify({ capabilities: { firefliesServerImport: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === `${backendUrl}/api/connectors/webhooks/purge-check`) {
          return new Response(JSON.stringify({ blocked: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const seenOn: Library[] = [];
      await renderProbe({
        tcw: tcwOn,
        visible: true,
        noteId: null,
        backendUrl,
        sessionStore: makeFakeSessionStore(),
        seen: seenOn,
      });
      await waitFor(
        () => Boolean(seenOn.at(-1)?.items.some((i) => i.id === liveId)),
        "live imported row shown in memory",
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      const persisted = await readLocal<{ items: Array<{ id: string }> }>(
        accountCacheKey(tcwOn.did!, "library"),
      );
      expect(persisted?.value.items.map((i) => i.id)).toEqual([sqlRowId]);
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = savedIdb;
    }
  });

  test("strips prior server-imported rows on failed refresh and revalidates settled imported transcripts on reopen", async () => {
    const backendUrl = "https://backend.example";
    const liveId = await connectorMeetingId("fireflies", "ff-reval");
    const sqlRowId = "sql-survives-1";
    let failSql = false;
    let purged = false;
    let failPurge = false;
    let purgeCalls = 0;

    const kvEntries: Record<string, { data: string; lastModified: string }> = {
      [firefliesMeetingKvKey("ff-reval")]: {
        data: await makeMeetingPayload("ff-reval", "Revalidated Fireflies Meeting"),
        lastModified: "2026-11-22T15:00:00.000Z",
      },
      [transcriptKvKey("fireflies", "ff-reval")]: {
        data: JSON.stringify([
          { index: 0, speaker_name: "Jordan", text: "Secret transcript line.", start_time: 0, end_time: 5 },
        ]),
        lastModified: "2026-11-22T15:01:00.000Z",
      },
    };

    const tcw = {
      did: "did:test:fireflies-reval-fail-refresh",
      spaceId: "fireflies-reval-fail-refresh",
      sql: {
        db: () => ({
          query: async (sql: string) => {
            if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: [] } };
            if (failSql) return { ok: false, error: { code: "NETWORK_ERROR", message: "offline" } };
            if (sql.includes("SELECT metadata FROM connector_meeting")) {
              return { ok: true, data: { rows: [] } };
            }
            return {
              ok: true,
              data: {
                rows: [[sqlRowId, "fireflies", "ff-sql-keep", "Browser SQL Row", "2026-11-22T12:00:00.000Z", 120]],
              },
            };
          },
        }),
      },
      kv: {
        list: async () => ({ ok: true, data: { keys: [firefliesMeetingKvKey("ff-reval")] } }),
        get: async (key: string) => {
          const entry = kvEntries[key];
          if (!entry) return { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
          return { ok: true, data: { data: entry.data, headers: makeKvHeaders(entry.lastModified) } };
        },
      },
    } as unknown as TinyCloudWeb;
    beginStorageAccountSession(tcw, tcw.did ?? null, tcw.spaceId ?? null);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${backendUrl}/api/server-info`) {
        return new Response(JSON.stringify({ capabilities: { firefliesServerImport: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${backendUrl}/api/connectors/webhooks/purge-check`) {
        purgeCalls += 1;
        if (failPurge) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ blocked: purged }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const sessionStore = makeFakeSessionStore();
    const seen: Library[] = [];

    // 1. Initial load + open settles metadata & transcript as ok.
    await renderProbe({ tcw, visible: true, noteId: liveId, backendUrl, sessionStore, seen });
    await waitFor(
      () => {
        const latest = seen.at(-1);
        return Boolean(
          latest &&
            latest.items.some((i) => i.id === liveId) &&
            latest.note.reads.metadata?.status === "ok" &&
            latest.note.reads.transcript?.transcript.status === "ok",
        );
      },
      "initial open settles imported metadata and transcript",
    );

    // 2. Close, mark purged on backend, then reopen: MUST revalidate settled reads and hide both!
    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });
    purged = true;
    const callsBeforeReopen = purgeCalls;
    await renderProbe({ tcw, visible: true, noteId: liveId, backendUrl, sessionStore, seen });
    await waitFor(
      () => {
        const reads = seen.at(-1)?.note.reads;
        return reads?.metadata?.status === "absent" && reads?.transcript?.transcript.status === "absent";
      },
      "reopening settled imported note revalidates and returns absent once purged",
    );
    expect(purgeCalls).toBeGreaterThanOrEqual(callsBeforeReopen + 2);

    // 3. Unpurge, settle again, then make purge-check fail with 503 on reopen: MUST NOT keep stale transcript!
    purged = false;
    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });
    await renderProbe({ tcw, visible: true, noteId: liveId, backendUrl, sessionStore, seen });
    await waitFor(
      () => seen.at(-1)?.note.reads.transcript?.transcript.status === "ok",
      "re-settled imported note is ok again",
    );
    failPurge = true;
    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });
    await renderProbe({ tcw, visible: true, noteId: liveId, backendUrl, sessionStore, seen });
    await waitFor(
      () => {
        const reads = seen.at(-1)?.note.reads;
        return reads?.metadata?.status === "absent" && reads?.transcript?.transcript.status === "absent";
      },
      "failed purge check on reopen does not keep stale settled transcript",
    );

    // 4. Failed refresh MUST strip prior server-imported rows while leaving ordinary SQL rows alone.
    failPurge = false;
    failSql = true;
    await act(async () => {
      seen.at(-1)!.refresh();
    });
    await waitFor(
      () => Boolean(seen.at(-1) && seen.at(-1)!.status === "failed" && !seen.at(-1)!.listing),
      "failed refresh settles",
    );
    expect(seen.at(-1)!.items.map((i) => i.id)).toEqual([sqlRowId]);
  });

  test("re-runs purge verdict for visible imported rows on visibility return and window focus", async () => {
    const backendUrl = "https://backend-vis.example";
    const visId = await connectorMeetingId("fireflies", "ff-vis-purge");
    const focusId = await connectorMeetingId("fireflies", "ff-focus-purge");
    const purgedIds = new Set<string>();

    const { tcw } = makeFakeTcw({
      [firefliesMeetingKvKey("ff-vis-purge")]: {
        data: await makeMeetingPayload("ff-vis-purge", "Purged Before Visibility Return"),
        lastModified: "2026-11-22T15:00:00.000Z",
      },
      [firefliesMeetingKvKey("ff-focus-purge")]: {
        data: await makeMeetingPayload("ff-focus-purge", "Purged Before Window Focus"),
        lastModified: "2026-11-22T15:05:00.000Z",
      },
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${backendUrl}/api/server-info`) {
        return new Response(JSON.stringify({ capabilities: { firefliesServerImport: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${backendUrl}/api/connectors/webhooks/purge-check`) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { meetingId: string };
        return new Response(JSON.stringify({ blocked: purgedIds.has(body.meetingId) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const sessionStore = makeFakeSessionStore();
    const seen: Library[] = [];

    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });
    await waitFor(
      () => Boolean(seen.at(-1) && !seen.at(-1)!.listing && seen.at(-1)!.items.length === 2),
      "both imported meetings listed",
    );

    // 1. Purge one meeting while away for < RELIST_AFTER_MS: returning to visible immediately re-runs purge check.
    await renderProbe({ tcw, visible: false, noteId: null, backendUrl, sessionStore, seen });
    purgedIds.add("ff-vis-purge");
    await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });
    await waitFor(
      () => Boolean(seen.at(-1) && !seen.at(-1)!.listing && seen.at(-1)!.items.every((i) => i.id !== visId)),
      "purged imported row removed on visibility return",
    );
    expect(seen.at(-1)!.items.map((i) => i.id)).toEqual([focusId]);

    // 2. Purge the remaining visible meeting while on screen, then dispatch window focus: row clears immediately.
    purgedIds.add("ff-focus-purge");
    await act(async () => {
      windowEvents.dispatchEvent(new Event("focus"));
    });
    await waitFor(
      () => Boolean(seen.at(-1) && !seen.at(-1)!.listing && seen.at(-1)!.items.length === 0),
      "purged imported row removed on window focus",
    );
  });

  test("resets list and cached reads on account switch so Account A imported rows never show for Account B", async () => {
    const backendUrl = "https://backend-acct.example";
    const acctAId = await connectorMeetingId("fireflies", "ff-acct-a");

    const { tcw: tcwA } = makeFakeTcw({
      [firefliesMeetingKvKey("ff-acct-a")]: {
        data: await makeMeetingPayload("ff-acct-a", "Account A Private Meeting"),
        lastModified: "2026-11-22T15:00:00.000Z",
      },
      [transcriptKvKey("fireflies", "ff-acct-a")]: {
        data: JSON.stringify([
          { index: 0, speaker_name: "Alice", text: "Account A private transcript.", start_time: 0, end_time: 4 },
        ]),
        lastModified: "2026-11-22T15:01:00.000Z",
      },
    });

    // Account B has a gated SQL/KV read so we observe the very first render after switching accounts.
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const tcwB = {
      did: "did:test:account-b-isolated",
      spaceId: "space-account-b",
      sql: {
        db: () => ({
          query: async (sql: string) => {
            if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: [] } };
            await gateB;
            return { ok: false, error: { code: "NOT_FOUND", message: "no such table: connector_meeting" } };
          },
        }),
      },
      kv: {
        list: async () => ({ ok: true, data: { keys: [] } }),
        get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } }),
      },
    } as unknown as TinyCloudWeb;

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${backendUrl}/api/server-info`) {
        return new Response(JSON.stringify({ capabilities: { firefliesServerImport: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${backendUrl}/api/connectors/webhooks/purge-check`) {
        return new Response(JSON.stringify({ blocked: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const sessionStoreA = makeFakeSessionStore("token-a");
    const sessionStoreB = makeFakeSessionStore("token-b");
    const seen: Library[] = [];

    // 1. Mount Account A and settle both list and open note reads.
    await renderProbe({ tcw: tcwA, visible: true, noteId: acctAId, backendUrl, sessionStore: sessionStoreA, seen });
    await waitFor(
      () => {
        const latest = seen.at(-1);
        return Boolean(
          latest &&
            latest.items.some((i) => i.id === acctAId) &&
            latest.note.reads.transcript?.transcript.status === "ok",
        );
      },
      "Account A loads imported meeting and transcript",
    );

    // 2. Switch mounted useLibrary from Account A to Account B without unmounting.
    const rendersBeforeSwitch = seen.length;
    beginStorageAccountSession(tcwB, tcwB.did ?? null, tcwB.spaceId ?? null);
    await renderProbe({ tcw: tcwB, visible: true, noteId: acctAId, backendUrl, sessionStore: sessionStoreB, seen });

    const rendersAfterSwitch = seen.slice(rendersBeforeSwitch);
    expect(rendersAfterSwitch.length).toBeGreaterThanOrEqual(1);
    // ZERO renders after switching to Account B may ever expose Account A's row or cached transcript!
    for (const snapshot of rendersAfterSwitch) {
      expect(snapshot.items.every((i) => i.id !== acctAId)).toBe(true);
      expect(snapshot.note.item).toBeNull();
      expect(snapshot.note.reads.transcript).toBeUndefined();
    }

    releaseB();
    await waitFor(
      () => Boolean(seen.at(-1) && seen.at(-1)!.status === "ready" && !seen.at(-1)!.listing),
      "Account B list settles empty",
    );
    expect(seen.at(-1)!.items).toEqual([]);
  });

  test("routes list, metadata and transcript reads through the per-space queue with Fireflies on and off (never raw tcw.kv/tcw.sql)", async () => {
    const assertQueuedMode = async (mode: "on" | "off") => {
      const spaceId = `per-space-queue-${mode}`;
      const did = `did:test:${spaceId}`;
      const liveId = mode === "on" ? await connectorMeetingId("fireflies", "ff-queued") : "sql-queued-1";
      const storageEvents: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;

      const track = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
        storageEvents.push(label);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await fn();
        } finally {
          inFlight -= 1;
        }
      };

      const kvEntries: Record<string, { data: string; lastModified: string }> = {
        [firefliesMeetingKvKey("ff-queued")]: {
          data: await makeMeetingPayload("ff-queued", "Queued Fireflies Meeting"),
          lastModified: "2026-11-22T15:00:00.000Z",
        },
        [transcriptKvKey("fireflies", mode === "on" ? "ff-queued" : "ff-sql-queued")]: {
          data: JSON.stringify([
            { index: 0, speaker_name: "Jordan", text: "Queued transcript line.", start_time: 0, end_time: 3 },
          ]),
          lastModified: "2026-11-22T15:01:00.000Z",
        },
      };

      const tcw = {
        did,
        spaceId,
        sql: {
          db: () => ({
            query: (sql: string) =>
              track("sql", async () => {
                if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: [] } };
                if (mode === "on") {
                  return { ok: false, error: { code: "NOT_FOUND", message: "no such table: connector_meeting" } };
                }
                if (sql.includes("SELECT metadata FROM connector_meeting")) {
                  return { ok: true, data: { rows: [[JSON.stringify({ source: "browser" })]] } };
                }
                return {
                  ok: true,
                  data: {
                    rows: [[liveId, "fireflies", "ff-sql-queued", "Queued SQL Meeting", "2026-11-22T15:00:00.000Z", 120]],
                  },
                };
              }),
          }),
        },
        kv: {
          list: (opts?: { path?: string; prefix?: string }) =>
            track("kv.list", async () => {
              const prefix = opts?.path ?? opts?.prefix ?? "";
              return { ok: true, data: { keys: Object.keys(kvEntries).filter((k) => k.startsWith(prefix)) } };
            }),
          get: (key: string) =>
            track(`kv.get:${key}`, async () => {
              const entry = kvEntries[key];
              if (!entry) return { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
              return { ok: true, data: { data: entry.data, headers: makeKvHeaders(entry.lastModified) } };
            }),
        },
      } as unknown as TinyCloudWeb;

      beginStorageAccountSession(tcw, did, spaceId);

      const backendUrl = mode === "on" ? "https://backend-queue.example" : undefined;
      const sessionStore = mode === "on" ? makeFakeSessionStore() : undefined;
      if (backendUrl) {
        globalThis.fetch = (async (input: string | URL | Request) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url === `${backendUrl}/api/server-info`) {
            return new Response(JSON.stringify({ capabilities: { firefliesServerImport: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url === `${backendUrl}/api/connectors/webhooks/purge-check`) {
            return new Response(JSON.stringify({ blocked: false }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("not found", { status: 404 });
        }) as typeof fetch;
      }

      // Hold the per-space queue BEFORE mounting useLibrary: no list read may hit raw tcw.sql/tcw.kv yet.
      let releaseListBarrier!: () => void;
      const listBarrierPromise = runOnSpace(spaceId, () => new Promise<void>((resolve) => {
        releaseListBarrier = resolve;
      }));

      const seen: Library[] = [];
      await renderProbe({ tcw, visible: true, noteId: null, backendUrl, sessionStore, seen });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(storageEvents).toEqual([]);

      releaseListBarrier();
      await listBarrierPromise;

      await waitFor(
        () => Boolean(seen.at(-1) && !seen.at(-1)!.listing && seen.at(-1)!.items.some((i) => i.id === liveId)),
        `list completes through per-space queue (${mode})`,
      );

      // Hold the per-space queue BEFORE opening the note: neither metadata nor transcript may bypass it.
      const eventsBeforeOpen = storageEvents.length;
      let releaseOpenBarrier!: () => void;
      const openBarrierPromise = runOnSpace(spaceId, () => new Promise<void>((resolve) => {
        releaseOpenBarrier = resolve;
      }));

      await renderProbe({ tcw, visible: true, noteId: liveId, backendUrl, sessionStore, seen });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(storageEvents.slice(eventsBeforeOpen)).toEqual([]);

      releaseOpenBarrier();
      await openBarrierPromise;

      await waitFor(
        () => {
          const reads = seen.at(-1)?.note.reads;
          return reads?.metadata?.status === "ok" && reads?.transcript?.transcript.status === "ok";
        },
        `metadata and transcript complete through per-space queue (${mode})`,
      );
      expect(maxInFlight).toBe(1);
      expect(storageEvents.slice(eventsBeforeOpen).some((e) => e.startsWith("kv.get:"))).toBe(true);

      await act(async () => {
        root!.unmount();
      });
      root = null;
      endStorageAccountSession();
    };

    await assertQueuedMode("off");
    await assertQueuedMode("on");
  });
});
