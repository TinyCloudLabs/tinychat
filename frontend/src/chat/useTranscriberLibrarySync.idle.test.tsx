// Idle polling cost of the mounted transcriber library sync: a fake clock drives the hook's
// scheduled interval and counts the reads that reach the user's space (SQL queries and KV gets).
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Database } from "bun:sqlite";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTOR_SCHEMA } from "@tinyboilerplate/core";

import type { TranscriberClient } from "@/lib/transcriberApi";
import { listSavedTranscriberMeetingIds, TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import {
  TRANSCRIBER_LIBRARY_IDLE_MS, TRANSCRIBER_LIBRARY_RETRY_MS, useTranscriberLibrarySync, type TranscriberLibrarySaver,
} from "./useTranscriberLibrarySync";

const globals = {
  window: (globalThis as { window?: unknown }).window,
  document: (globalThis as { document?: unknown }).document,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
const BASE = Date.parse("2026-10-26T00:00:00Z");
const listeners = new Map<string, Set<() => void>>();
const on = (event: string, fn: () => void) => {
  const group = listeners.get(event) ?? new Set<() => void>();
  group.add(fn);
  listeners.set(event, group);
};
const off = (event: string, fn: () => void) => listeners.get(event)?.delete(fn);
const fire = (event: string) => { for (const fn of listeners.get(event) ?? []) fn(); };
const doc = { visibilityState: "visible", addEventListener: on, removeEventListener: off };

// The fake clock: `window.setInterval` registers here and fires only when `advance` passes its time.
const intervals = new Map<number, { fn: () => void; ms: number; next: number }>();
let nextTimerId = 1;
let elapsed = 0;
let heartbeats = 0;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    setInterval: (fn: () => void, ms: number) => {
      const id = nextTimerId++;
      intervals.set(id, { fn, ms, next: elapsed + ms });
      return id;
    },
    clearInterval: (id: number) => { intervals.delete(id); },
    addEventListener: on,
    removeEventListener: off,
    HTMLIFrameElement: class {},
  };
  (globalThis as { document?: unknown }).document = doc;
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = globals.window;
  (globalThis as { document?: unknown }).document = globals.document;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = globals.act;
  setSystemTime();
});

const newContainer = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  listeners.clear();
  intervals.clear();
  doc.visibilityState = "visible";
  elapsed = 0;
  heartbeats = 0;
  setSystemTime();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
/** Move the fake clock forward, firing each due interval (and letting its pass finish) in time order. */
async function advance(ms: number) {
  const end = elapsed + ms;
  for (;;) {
    const due = [...intervals.values()].filter((timer) => timer.next <= end).sort((a, b) => a.next - b.next)[0];
    if (!due) break;
    elapsed = due.next;
    due.next += due.ms;
    setSystemTime(BASE + elapsed);
    heartbeats++;
    await act(async () => { due.fn(); });
    await settle();
  }
  elapsed = end;
  setSystemTime(BASE + elapsed);
}

const counts = { sql: 0, kv: 0, lists: 0 };
const completed = (id: string) => ({ id, status: "completed" });

/** A user space with three saved recordings; every SQL query and KV get is counted. */
function space() {
  const db = new Database(":memory:");
  for (const { sql: ddl } of CONNECTOR_SCHEMA) db.exec(ddl);
  const insert = db.query(`INSERT INTO connector_meeting (id, source, source_id, metadata, created_at, updated_at) VALUES (?, ?, ?, '{}', 'c', 'u')`);
  for (let n = 0; n < 3; n++) insert.run(`row-${n}`, TRANSCRIBER_MEETING_SOURCE, `m-${n}`);
  const snapshot = new Map<string, { value: string; etag: string }>();
  const tcw = {
    did: `did:test:idle-${crypto.randomUUID()}`, secrets: { isUnlocked: true },
    sql: { db: () => ({
      query: async (q: string, p: never[] = []) => { counts.sql++; return { ok: true, data: { rows: db.query(q).values(...p) } }; },
      execute: async (q: string, p: never[] = []) => { counts.sql++; return { ok: true, data: db.query(q).run(...p) }; },
    }) },
    kv: {
      get: async (key: string) => {
        counts.kv++;
        if (key.includes("/transcript/")) return { ok: true, data: { data: "body" } };
        const stored = snapshot.get(key);
        return stored ? { ok: true, data: { data: stored.value, headers: { etag: stored.etag } } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
      },
      put: async (key: string, value: string) => { snapshot.set(key, { value, etag: `e${snapshot.size}-${value.length}` }); return { ok: true }; },
    },
  } as unknown as TinyCloudWeb;
  return tcw;
}
const session = () => ({ getToken: () => "token", getAddress: () => "0xidle", isExpired: () => false }) as SessionStore;
const listClient = (rows: unknown[], onList: () => void = () => {}) => ({
  list: async () => { counts.lists++; onList(); return { status: "ok", value: { meetings: rows } }; },
  transcript: async () => ({ status: "ok", value: { status: "ready", transcript: { meeting_id: "x", status: "completed", version: 1, segments: [] } } }),
}) as unknown as TranscriberClient;
const realSaver: TranscriberLibrarySaver = { listSaved: listSavedTranscriberMeetingIds, save: async () => ({ ok: true }) };

function Probe(props: { tcw: TinyCloudWeb; client: TranscriberClient; saver: TranscriberLibrarySaver; sessionStore: SessionStore }) {
  useTranscriberLibrarySync({ ...props, backendUrl: "https://example.test" });
  return null;
}
async function mount(props: Parameters<typeof Probe>[0]) {
  const root = createRoot(newContainer());
  roots.push(root);
  setSystemTime(BASE + elapsed);
  await act(async () => root.render(<Probe {...props} />));
  await settle();
}
const savedRows = () => ["m-0", "m-1", "m-2"].map(completed);
async function mountIdleLibrary() {
  counts.sql = counts.kv = counts.lists = 0;
  const props = { tcw: space(), client: listClient(savedRows()), saver: realSaver, sessionStore: session() };
  await mount(props);
  return props;
}
const reads = () => counts.sql + counts.kv;

test("an idle visible tab makes at most one node read pair per two minutes", async () => {
  await mountIdleLibrary();
  expect(counts.lists).toBe(1); // the mount pass
  const mountReads = reads();
  expect(mountReads).toBeGreaterThan(0);
  const readsPerPass: number[] = [];
  let seen = counts.lists;
  let before = reads();
  for (let second = 0; second < 300; second += 30) {
    await advance(30_000);
    if (counts.lists > seen) { readsPerPass.push(reads() - before); seen = counts.lists; }
    before = reads();
  }
  expect(heartbeats).toBe(10); // the interval kept firing: the cadence is the gate's doing
  expect(counts.lists - 1).toBe(2); // passes at 2 and 4 minutes, none at 30/60/90/150/180/210/270/300 s
  // Steady state, a pass is one SQL read of the saved ids and one KV read of the pending snapshot.
  expect(readsPerPass).toEqual([2, 2]);
  expect(TRANSCRIBER_LIBRARY_IDLE_MS).toBeGreaterThanOrEqual(120_000);
});

test("a hidden tab makes no scheduled pass, and returning to it starts one at once", async () => {
  await mountIdleLibrary();
  const mountReads = reads();
  doc.visibilityState = "hidden";
  await advance(5 * 60_000);
  expect(heartbeats).toBe(10);
  expect(counts.lists).toBe(1);
  expect(reads()).toBe(mountReads);
  doc.visibilityState = "visible";
  await act(async () => { fire("visibilitychange"); });
  await settle();
  expect(counts.lists).toBe(2); // no waiting for the next heartbeat
  expect(reads()).toBeGreaterThan(mountReads);
  // Scheduled passes resume on the idle cadence from the one just made.
  await advance(90_000);
  expect(counts.lists).toBe(2);
  await advance(30_000);
  expect(counts.lists).toBe(3);
});

test("a recording that fails to save is retried on the 30 second cadence, then the tab goes idle", async () => {
  counts.sql = counts.kv = counts.lists = 0;
  let saves = 0;
  const saver: TranscriberLibrarySaver = {
    listSaved: async () => ({ ok: true, data: { saved: [], unknown: [] } }),
    save: async () => { saves++; return { ok: saves >= 3 }; },
  };
  await mount({ tcw: space(), client: listClient([completed("bad")]), saver, sessionStore: session() });
  expect(saves).toBe(1);
  await advance(TRANSCRIBER_LIBRARY_RETRY_MS);
  expect(saves).toBe(2);
  await advance(TRANSCRIBER_LIBRARY_RETRY_MS);
  expect(saves).toBe(3); // saved on the third try
  expect(counts.lists).toBe(3);
  await advance(90_000); // settled: heartbeats at 90, 120, 150 s make no pass
  expect(counts.lists).toBe(3);
  await advance(30_000);
  expect(counts.lists).toBe(4); // idle cadence from the pass at 60 s
});

test("a pass whose list call fails is retried on the 30 second cadence", async () => {
  counts.sql = counts.kv = counts.lists = 0;
  let healthy = false;
  const client = {
    list: async () => { counts.lists++; return healthy ? { status: "ok", value: { meetings: savedRows() } } : { status: "error" }; },
    transcript: async () => ({ status: "error" }),
  } as unknown as TranscriberClient;
  await mount({ tcw: space(), client, saver: realSaver, sessionStore: session() });
  await advance(30_000);
  await advance(30_000);
  expect(counts.lists).toBe(3);
  healthy = true;
  await advance(30_000);
  expect(counts.lists).toBe(4);
  await advance(90_000);
  expect(counts.lists).toBe(4);
});

test("tabs of one account still share a pass: a tick right after another tab's pass is skipped", async () => {
  counts.sql = counts.kv = counts.lists = 0;
  const tcw = space();
  let listsA = 0;
  let listsB = 0;
  const propsA = { tcw, client: listClient(savedRows(), () => { listsA++; }), saver: realSaver, sessionStore: session() };
  const propsB = { tcw, client: listClient(savedRows(), () => { listsB++; }), saver: realSaver, sessionStore: session() };
  await mount(propsA);
  await mount(propsB);
  expect([listsA, listsB]).toEqual([1, 1]);
  await advance(TRANSCRIBER_LIBRARY_IDLE_MS); // tab A's heartbeat is first in line and passes; tab B sees it
  expect([listsA, listsB]).toEqual([2, 1]);
});
