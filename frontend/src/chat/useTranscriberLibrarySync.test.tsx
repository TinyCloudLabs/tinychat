// Mounted sync: triggers share one pass, and locked secrets do not erase the
// baseline of meetings already in Library when the provider first appeared.
import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { captureEvents } from "@/capture/captureEvents";
import { notifySecretsUnlockedForTests } from "@/lib/connectors/connectorSecrets";
import { setSecretsAvailableForTests } from "@/lib/openkeyNative";
import { PENDING_RECONCILE_SNAPSHOT_KEY } from "@/lib/connectors/pendingReconcileSnapshot";
import type { TranscriberClient } from "@/lib/transcriberApi";
import { TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { harnessSessionStore } from "@/harness/stubs";
import { syncTranscriberLibrary, useTranscriberLibrarySync, type TranscriberLibrarySaver } from "./useTranscriberLibrarySync";

const globals = {
  window: (globalThis as { window?: unknown }).window,
  document: (globalThis as { document?: unknown }).document,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
const listeners = new Map<string, Set<() => void>>();
let interval: (() => void) | undefined;
const on = (event: string, fn: () => void) => {
  const group = listeners.get(event) ?? new Set<() => void>();
  group.add(fn);
  listeners.set(event, group);
};
const off = (event: string, fn: () => void) => listeners.get(event)?.delete(fn);
const fire = (event: string) => { for (const fn of listeners.get(event) ?? []) fn(); };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    setInterval: (fn: () => void) => { interval = fn; return 1; },
    clearInterval: () => { interval = undefined; },
    addEventListener: on,
    removeEventListener: off,
    HTMLIFrameElement: class {},
  };
  (globalThis as { document?: unknown }).document = {
    visibilityState: "visible", addEventListener: on, removeEventListener: off,
  };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = globals.window;
  (globalThis as { document?: unknown }).document = globals.document;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = globals.act;
});

const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  listeners.clear();
  interval = undefined;
});

function Probe(props: Parameters<typeof useTranscriberLibrarySync>[0] & { client: TranscriberClient; saver: TranscriberLibrarySaver }) {
  useTranscriberLibrarySync(props);
  return null;
}
async function mount(props: Parameters<typeof Probe>[0]) {
  root = createRoot(container);
  await act(async () => root!.render(<Probe {...props} />));
}
const row = (id: string) => ({ id, status: "completed" });
function setup(locked = false) {
  const secrets = { isUnlocked: !locked };
  const tcw = { did: "did:test:sync", secrets } as unknown as TinyCloudWeb;
  const identity = { address: "0xaccount-a", token: "token", expired: false };
  const sessionStore = {
    getToken: () => identity.token, getAddress: () => identity.address, isExpired: () => identity.expired,
  } as SessionStore;
  const savedIds = ["initial"];
  const rows = [row("initial")];
  const saver: TranscriberLibrarySaver = {
    listSaved: async () => ({ ok: true, data: { saved: [...savedIds], unknown: [] } }),
    save: async () => ({ ok: true }),
  };
  const client = {
    list: async () => ({ status: "ok", value: { meetings: rows } }),
    transcript: async () => ({ status: "error" }),
  } as unknown as TranscriberClient;
  return { tcw, sessionStore, identity, secrets, savedIds, rows, saver, client, backendUrl: "https://example.test" };
}

test("snapshot uses the already-fetched transcriber list and existing saved-id scan", async () => {
  const f = setup();
  f.rows.push(row("pending-unsaved"), { id: "in-progress", status: "processing" } as never);
  let listCalls = 0;
  f.client.list = async () => {
    listCalls++;
    return { status: "ok", value: { meetings: f.rows } } as never;
  };
  let snapshot: { ids: string[]; savedIds: string[] } | undefined;
  await syncTranscriberLibrary({
    tcw: f.tcw,
    client: f.client,
    saver: f.saver,
    onPendingSnapshot: async (rows, savedIds) => {
      snapshot = { ids: rows.map((meeting) => meeting.id), savedIds: [...savedIds] };
    },
  });
  expect(listCalls).toBe(1);
  expect(snapshot).toEqual({ ids: ["initial", "pending-unsaved", "in-progress"], savedIds: ["initial"] });
});
test("captures the transcriber observation immediately before the existing list call", async () => {
  const f = setup();
  const events: string[] = [];
  const observedAt = "2026-10-13T09:00:00.000Z";
  let callbackAt: string | undefined;
  f.client.list = async () => {
    events.push("list");
    return { status: "ok", value: { meetings: f.rows } } as never;
  };
  await syncTranscriberLibrary({
    tcw: f.tcw,
    client: f.client,
    saver: f.saver,
    observedAt: () => { events.push("observedAt"); return observedAt; },
    onPendingSnapshot: (async (_rows: unknown, _saved: unknown, _unknown: unknown, at: string) => {
      events.push("snapshot");
      callbackAt = at;
    }) as never,
  });
  expect(callbackAt).toBe(observedAt);
  expect(events).toEqual(["observedAt", "list", "snapshot"]);
});
test("mounted sync stores only completed unsaved metadata from its existing list pass", async () => {
  const f = setup();
  f.rows.push({
    id: "ptx-pending",
    status: "completed",
    created_at: "2026-10-03T00:00:00Z",
    completed_at: "2026-10-03T01:00:00Z",
    meeting_url: "PRIVATE_URL",
    transcript: { text: "PRIVATE_CONTENT" },
    metadata: { calendar_title: "PRIVATE_TITLE" },
  } as never);
  const entries = new Map<string, string>();
  const writes: string[] = [];
  let listCalls = 0;
  f.client.list = async () => {
    listCalls++;
    return { status: "ok", value: { meetings: f.rows } } as never;
  };
  Object.assign(f.tcw, {
    kv: {
      get: async (key: string) => entries.has(key)
        ? { ok: true as const, data: { data: entries.get(key) } }
        : { ok: false as const, error: { code: "KV_NOT_FOUND" } },
      put: async (key: string, value: string) => {
        entries.set(key, value);
        writes.push(key);
        return { ok: true as const };
      },
    },
  });
  await mount(f);
  const serialized = entries.get(`${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`) ?? "";
  expect(listCalls).toBe(1);
  expect(writes).toEqual([`${PENDING_RECONCILE_SNAPSHOT_KEY}/transcriber`]);
  const snapshot = JSON.parse(serialized);
  expect(snapshot).toEqual({
    version: 1,
    changed_at: expect.any(String),
    checked_at: expect.any(String),
    count: 1,
    meetings: [{
      id: "ptx-pending",
      source: "transcriber",
      createdAt: "2026-10-03T00:00:00Z",
      completedAt: "2026-10-03T01:00:00Z",
      status: "completed",
      reconciled: false,
    }],
  });
  expect(serialized).not.toMatch(/title|participant|email|url|content|transcript|summary|error|PRIVATE_/i);
});
test("does not publish a listed row after the active account changes", async () => {
  const f = setup();
  let active = true;
  let snapshotCalls = 0;
  f.client.list = async () => ({ status: "ok", value: { meetings: [row("previous-account")] } }) as never;
  f.saver.listSaved = async () => {
    active = false;
    return { ok: true, data: { saved: [], unknown: [] } };
  };
  await syncTranscriberLibrary({
    tcw: f.tcw,
    client: f.client,
    saver: f.saver,
    isCurrent: () => active,
    onPendingSnapshot: async () => { snapshotCalls++; },
  });
  expect(snapshotCalls).toBe(0);
});

test("focus, online and interval triggers cannot queue overlapping notetaker passes", async () => {
  const f = setup();
  const pending = Promise.withResolvers<{ status: "ok"; value: { meetings: typeof f.rows } }>();
  const started = Promise.withResolvers<void>();
  let lists = 0;
  f.client.list = async () => { lists++; started.resolve(); return pending.promise as never; };
  await mount(f);
  await started.promise;
  await act(async () => { fire("focus"); fire("online"); interval?.(); fire("focus"); });
  expect(lists).toBe(1);
  pending.resolve({ status: "ok", value: { meetings: f.rows } });
  await act(async () => {});
  expect(lists).toBe(1);
});

test("the mounted hook emits once for a new remote meeting, not mount history or later passes", async () => {
  const f = setup();
  const changes: Array<{ source: string; sourceId: string } | undefined> = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail));
  try {
    await mount(f);
    expect(changes).toEqual([]);
    f.savedIds.push("remote");
    f.rows.push(row("remote"));
    await act(async () => { fire("focus"); });
    expect(changes).toEqual([{ source: TRANSCRIBER_MEETING_SOURCE, sourceId: "remote" }]);
    await act(async () => { fire("online"); interval?.(); });
    expect(changes).toHaveLength(1);
  } finally { unsubscribe(); }
});

test("the signed-in browser harness refreshes a meeting imported elsewhere", async () => {
  const f = setup();
  const changes: Array<{ source: string; sourceId: string } | undefined> = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail));
  try {
    await mount({ ...f, sessionStore: harnessSessionStore });
    expect(changes).toEqual([]);
    f.savedIds.push("remote-in-harness");
    f.rows.push(row("remote-in-harness"));
    await act(async () => { fire("focus"); });
    expect(changes).toEqual([{ source: TRANSCRIBER_MEETING_SOURCE, sourceId: "remote-in-harness" }]);
  } finally { unsubscribe(); }
});

test("the mounted hook emits exactly once on a successful save, never on a failed save", async () => {
  const f = setup();
  f.rows.push(row("saved-here"), row("failed-here"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  f.saver.save = async (_, meeting) => {
    if (meeting.id === "failed-here") return { ok: false };
    f.savedIds.push(meeting.id);
    return { ok: true };
  };
  const changes: Array<{ source: string; sourceId: string } | undefined> = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail));
  try {
    await mount(f);
    expect(changes).toEqual([{ source: TRANSCRIBER_MEETING_SOURCE, sourceId: "saved-here" }]);
    await act(async () => { fire("focus"); });
    expect(changes).toHaveLength(1);
  } finally { unsubscribe(); }
});

test("a save completing after JWT expiry still refreshes the mounted account", async () => {
  const f = setup();
  f.rows.push(row("saved-late"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  f.saver.save = () => { started.resolve(); return pending.promise; };
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    await mount(f);
    await started.promise;
    f.identity.expired = true;
    pending.resolve({ ok: true });
    await act(async () => {});
    expect(changes).toEqual(["saved-late"]);
  } finally { unsubscribe(); }
});

test("an in-flight save cannot emit into a different account", async () => {
  const f = setup();
  f.rows.push(row("old-account"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  f.saver.save = () => { started.resolve(); return pending.promise; };
  let snapshotReads = 0;
  let snapshotWrites = 0;
  Object.assign(f.tcw, { kv: {
    get: async () => { snapshotReads++; return { ok: false as const, error: { code: "KV_NOT_FOUND" } }; },
    put: async () => { snapshotWrites++; return { ok: true as const }; },
  } });
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    await mount(f);
    await started.promise;
    f.identity.address = "0xaccount-b";
    pending.resolve({ ok: true });
    await act(async () => {});
    expect(changes).toEqual([]);
    expect(snapshotReads).toBe(0);
    expect(snapshotWrites).toBe(0);
  } finally { unsubscribe(); }
});

test("a cleared token without an address change cannot publish an in-flight import", async () => {
  const f = setup();
  f.rows.push(row("signed-out"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  f.saver.save = () => { started.resolve(); return pending.promise; };
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    await mount(f);
    await started.promise;
    f.identity.token = "";
    pending.resolve({ ok: true });
    await act(async () => {});
    expect(changes).toEqual([]);
  } finally { unsubscribe(); }
});

test("changing the mounted DID also suppresses a late save", async () => {
  const f = setup();
  f.rows.push(row("old-did"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  f.saver.save = () => { started.resolve(); return pending.promise; };
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    await mount(f);
    await started.promise;
    Object.assign(f.tcw, { did: "did:test:other" });
    pending.resolve({ ok: true });
    await act(async () => {});
    expect(changes).toEqual([]);
  } finally { unsubscribe(); }
});

test("an in-flight save cannot emit after the provider unmounts", async () => {
  const f = setup();
  f.rows.push(row("unmounted"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ ok: boolean }>();
  f.saver.save = () => { started.resolve(); return pending.promise; };
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    await mount(f);
    await started.promise;
    await act(async () => root!.unmount());
    root = null;
    pending.resolve({ ok: true });
    await act(async () => {});
    expect(changes).toEqual([]);
  } finally { unsubscribe(); }
});

test("meetings imported while secrets were locked are new after unlock", async () => {
  const f = setup(true);
  let savedReads = 0;
  let clientReads = 0;
  const listSaved = f.saver.listSaved;
  f.saver.listSaved = (tcw) => { savedReads++; return listSaved(tcw); };
  const list = f.client.list.bind(f.client);
  f.client.list = async () => { clientReads++; return list(); };
  const changes: Array<{ source: string; sourceId: string } | undefined> = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail));
  try {
    await mount(f);
    expect(savedReads).toBe(1);
    expect(clientReads).toBe(0);
    expect(changes).toEqual([]);
    f.savedIds.push("remote-while-locked");
    f.rows.push(row("remote-while-locked"));
    f.secrets.isUnlocked = true;
    await act(async () => notifySecretsUnlockedForTests());
    expect(changes).toEqual([{ source: TRANSCRIBER_MEETING_SOURCE, sourceId: "remote-while-locked" }]);
    await act(async () => { fire("focus"); });
    expect(changes).toHaveLength(1);
  } finally { unsubscribe(); }
});

test("native OpenKey sessions sync meetings without a secrets space", async () => {
  const f = setup(true);
  f.rows.push(row("native-save"));
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: {} } }) as never;
  f.saver.save = async () => ({ ok: true });
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    setSecretsAvailableForTests(false);
    await mount(f);
    expect(changes).toEqual(["native-save"]);
  } finally {
    unsubscribe();
    setSecretsAvailableForTests(null);
  }
});

test("a mounted publication refresh emits library-changed once for an already known id", async () => {
  const { Database } = await import("bun:sqlite");
  const { saveTranscriberMeeting, refreshTranscriberMeeting, listSavedTranscriberMeetingIds, listSavedTranscriberVersions } = await import("@/lib/transcriberSave");
  const f = setup();
  const sql = new Database(":memory:");
  const bodies = new Map<string, string>();
  f.tcw = {
    ...f.tcw,
    sql: { db: () => ({
      query: async (query: string, params: never[] = []) => ({ ok: true, data: { rows: sql.query(query).values(...params) } }),
      execute: async (query: string, params: never[] = []) => ({ ok: true, data: sql.query(query).run(...params) }),
    }) },
    kv: {
      get: async (key: string) => bodies.has(key) ? { ok: true, data: { data: bodies.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND" } },
      put: async (key: string, value: string, options?: { ifNoneMatch?: string }) => {
        if (options?.ifNoneMatch === "*" && bodies.has(key)) return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
        bodies.set(key, value); return { ok: true };
      },
    },
  } as unknown as TinyCloudWeb;
  const meeting = { id: "initial", status: "completed" as const, platform: "jitsi", meeting_url: "https://example.test/fixture",
    created_at: "2026-01-01T00:00:00Z", transcript: { version: 2 } };
  const transcript = { meeting_id: "initial", status: "completed" as const, version: 1, segments: [] };
  f.saver = { listSaved: listSavedTranscriberMeetingIds, listVersions: listSavedTranscriberVersions,
    save: saveTranscriberMeeting, refresh: refreshTranscriberMeeting };
  f.client.list = async () => ({ status: "ok", value: { meetings: [meeting] } });
  f.client.transcript = async () => ({ status: "ok", value: { status: "ready", transcript: { ...transcript, version: 2 } } });
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    expect((await saveTranscriberMeeting(f.tcw, meeting, transcript)).ok).toBe(true);
    await mount(f);
    expect(changes).toEqual(["initial"]);
    await act(async () => { fire("focus"); });
    expect(changes).toEqual(["initial"]);
    expect(sql.query("SELECT json_extract(metadata, '$.ptx_transcript_version') AS version FROM connector_meeting").get())
      .toEqual({ version: 2 });
  } finally { unsubscribe(); sql.close(); }
});

test("open tabs of one account share one pass per interval, and every tab shows the pass's row states (TC-1274)", async () => {
  const f = setup();
  let lists = 0;
  let release: (() => void) | null = null;
  f.client.list = async () => {
    lists++;
    if (release === null && lists === 4) await new Promise<void>((resolve) => { release = resolve; });
    return { status: "ok", value: { meetings: f.rows } } as never;
  };
  // Tab B's own passes list nothing, so any row state it shows came from tab A.
  const clientB = { ...f.client, list: async () => { lists++; return { status: "ok", value: { meetings: [] } }; } } as unknown as TranscriberClient;
  // Web Locks as browsers grant them: an `ifAvailable` request gets null while another tab holds the name.
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  } });
  const ticks: Array<() => void> = [];
  const win = window as unknown as { setInterval: (fn: () => void) => number };
  const plainSetInterval = win.setInterval;
  win.setInterval = (fn) => { ticks.push(fn); return ticks.length; };
  const states: Array<Readonly<Record<string, string>>> = [{}, {}];
  function Tab(props: Parameters<typeof Probe>[0] & { tab: number }) {
    states[props.tab] = useTranscriberLibrarySync(props);
    return null;
  }
  const tabs = [createRoot(container), createRoot(container)];
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const start = Date.parse("2026-10-17T00:00:00Z");
  try {
    setSystemTime(start);
    for (const [tab, tabRoot] of tabs.entries()) {
      await act(async () => tabRoot.render(<Tab {...f} client={tab === 0 ? f.client : clientB} tab={tab} />));
      await settle();
    }
    expect(lists).toBe(2); // each tab's mount pass
    expect(states[1]).toEqual({});
    setSystemTime(start + 30_000);
    await act(async () => { ticks[0]!(); });
    await settle();
    await act(async () => { ticks[1]!(); });
    await settle();
    expect(lists).toBe(3); // tab B's tick saw tab A's finished pass
    expect(states[1]).toEqual({ initial: "saved" });
    setSystemTime(start + 60_000);
    await act(async () => { ticks[0]!(); });
    await settle();
    expect(lists).toBe(4); // tab A is mid-pass and holds the lock
    await act(async () => { ticks[1]!(); });
    await settle();
    expect(lists).toBe(4);
    release!();
    await settle();
  } finally {
    for (const tabRoot of tabs) await act(async () => tabRoot.unmount());
    win.setInterval = plainSetInterval;
    Reflect.deleteProperty(navigator, "locks");
    setSystemTime();
  }
});

test("an offline tab starts no pass until it is back online", async () => {
  const f = setup();
  let lists = 0;
  f.client.list = async () => { lists++; return { status: "ok", value: { meetings: f.rows } } as never; };
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  try {
    await mount(f);
    await act(async () => { fire("focus"); interval?.(); });
    expect(lists).toBe(0);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => { fire("online"); });
    expect(lists).toBe(1);
  } finally { Reflect.deleteProperty(navigator, "onLine"); }
});
