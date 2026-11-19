import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { captureEvents } from "@/capture/captureEvents";
import { combineMeetings } from "@/lib/connectors/combinedMeetingStore";
import { runGranolaSpaceWrite } from "@/lib/connectors/granolaSync";
import { accountCacheKey, readLocal, resetLocalCacheForTests, writeLocal } from "@/lib/localFirst/localCache";
import type { Library } from "@/capture/library/useLibrary";
import type { LibraryItem } from "@/capture/library/LibraryRow";
import { installDom } from "@/test/dom";

const restoreDom = installDom();
afterAll(restoreDom);
// React DOM and Radix capture browser globals at import time; this test loads the detail only after installing its isolated DOM.
const { createRoot } = await import("react-dom/client");
const { NoteDetail } = await import("@/capture/library/NoteDetail");
const connectorStore = await import("@/lib/connectors/connectorStore");
const { importGranolaCsv } = await import("@/lib/connectors/granolaCsvImport");
const { useLibrary } = await import("@/capture/library/useLibrary");

const csv = "Title,Created,Summary,Transcript\nFirst CSV meeting,2026-11-10T14:00:00Z,First summary,QA: first\nOther CSV meeting,2026-11-11T14:00:00Z,Other summary,QA: other";
const ok = <T,>(data: T) => ({ ok: true as const, data });

function fixture() {
  const db = new Database(":memory:");
  const kv = new Map<string, unknown>();
  const storage = {
    failDelete: false, deleting: false, deleteCalls: 0, waitForDelete: undefined as Promise<void> | undefined,
    failLists: false, listStarted: false, waitForList: undefined as Promise<void> | undefined,
  };
  const run = (sql: string, params: SQLQueryBindings[] = []) => {
    const result = db.query(sql).run(...params);
    return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
  };
  const tcw = {
    did: `did:fixture:${crypto.randomUUID()}`,
    spaceId: `fixture-space:${crypto.randomUUID()}`,
    sql: { db: () => ({
      query: async (sql: string, params: SQLQueryBindings[] = []) => {
        const rows = db.query(sql).values(...params);
        if (sql.includes("WHERE +c.source IN")) {
          storage.listStarted = true;
          const fail = storage.failLists;
          await storage.waitForList;
          if (fail) return { ok: false, error: { code: "STORAGE_ERROR", message: "list unavailable" } };
        }
        return ok({ rows });
      },
      execute: async (sql: string, params: SQLQueryBindings[] = []) => ok(run(sql, params)),
      batch: async (statements: { sql: string; params?: SQLQueryBindings[] }[]) => ok(db.transaction(() => statements.map(statement => run(statement.sql, statement.params)))()),
    }) },
    kv: {
      get: async (key: string) => kv.has(key) ? ok({ data: kv.get(key), headers: {} }) : { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } },
      put: async (key: string, value: unknown) => { kv.set(key, value); return ok({ data: undefined, headers: {} }); },
      delete: async (key: string) => {
        storage.deleting = true;
        storage.deleteCalls++;
        await storage.waitForDelete;
        if (storage.failDelete) return { ok: false, error: { code: "STORAGE_ERROR", message: "delete unavailable" } };
        kv.delete(key);
        return ok({ data: undefined, headers: {} });
      },
      list: async ({ path }: { path: string }) => ok({ keys: [...kv.keys()].filter(key => key.startsWith(path)), truncated: false }),
    },
  } as unknown as TinyCloudWeb;
  return { db, kv, tcw, storage };
}

const button = (label: string) => [...(document.querySelector('[role="dialog"][data-state="open"]') ?? document).querySelectorAll("button")].find(element => element.textContent?.trim() === label);
async function click(label: string) {
  const target = button(label);
  expect(target, `Missing ${label} control`).toBeDefined();
  expect(target!.disabled).toBe(false);
  await act(async () => target!.click());
}
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await act(async () => { await Bun.sleep(10); });
  }
  expect(condition()).toBe(true);
}

test("a CSV-only owner can confirm deletion of one imported meeting without deleting another", async () => {
  const f = fixture();
  const imported = await importGranolaCsv({ tcw: f.tcw, store: connectorStore, text: csv, checkPurge: async () => false });
  expect(imported.ok).toBe(true);
  expect(f.db.query("SELECT count(*) FROM connector_state WHERE status = 'connected'").values()[0]?.[0]).toBe(0);
  const rows = f.db.query("SELECT id, source_id, title, started_at, metadata FROM connector_meeting ORDER BY title").values() as [string, string, string, string, string][];
  const items: LibraryItem[] = rows.map(([id, sourceId, title, startedAt, metadata]) => ({ id, source: "granola", sourceId, title, startedAt, durationSecs: null, metadata: JSON.parse(metadata) }));
  const selected = items[0]!;
  const firstBody = connectorStore.transcriptKvKey("granola", selected.sourceId);
  const otherBody = connectorStore.transcriptKvKey("granola", items[1]!.sourceId);
  let left = false;
  let refreshed = false;
  const library: Library = {
    status: "ready", items, all: items, isCombinedMember: () => false, listing: false, filter: "all", setFilter: () => {},
    refresh: () => { refreshed = true; }, retry: () => {},
    note: { item: selected, audio: null, reads: { metadata: { status: "ok", metadata: selected.metadata! } } },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryRouter><NoteDetail library={library} tcw={f.tcw} pushed onBack={() => { left = true; }} transcription={undefined} /></MemoryRouter>));
    await click("Delete meeting");
    expect(f.db.query("SELECT count(*) FROM connector_meeting").values()[0]?.[0]).toBe(2);
    await click("Delete meeting");
    await until(() => left && refreshed);
    expect(f.db.query("SELECT title FROM connector_meeting").values()).toEqual([["Other CSV meeting"]]);
    expect(f.kv.has(firstBody)).toBe(false);
    expect(f.kv.has(otherBody)).toBe(true);
    const repeat = await importGranolaCsv({ tcw: f.tcw, store: connectorStore, text: csv, checkPurge: async () => false });
    expect(repeat.ok && repeat.data.skippedDeleted).toBe(1);
    expect(f.db.query("SELECT title FROM connector_meeting").values()).toEqual([["Other CSV meeting"]]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    f.db.close();
  }
});

async function importedFixture() {
  const f = fixture();
  const imported = await importGranolaCsv({ tcw: f.tcw, store: connectorStore, text: csv, checkPurge: async () => false });
  expect(imported.ok).toBe(true);
  const rows = f.db.query("SELECT id, source_id, title, started_at, metadata FROM connector_meeting ORDER BY title").values() as [string, string, string, string, string][];
  const items: LibraryItem[] = rows.map(([id, sourceId, title, startedAt, metadata]) => ({ id, source: "granola", sourceId, title, startedAt, durationSecs: null, metadata: JSON.parse(metadata) }));
  return { ...f, items };
}

function libraryFor(items: LibraryItem[], selected = items[0]!): Library {
  return {
    status: "ready", items, all: items, isCombinedMember: () => false, listing: false, filter: "all", setFilter: () => {},
    refresh: () => {}, retry: () => {},
    note: { item: selected, audio: null, reads: { metadata: { status: "ok", metadata: selected.metadata! } } },
  };
}

function detailHost() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  return {
    render: async (library: Library, tcw: TinyCloudWeb, onBack = () => {}) => {
      await act(async () => root.render(<MemoryRouter><NoteDetail library={library} tcw={tcw} pushed onBack={onBack} transcription={undefined} /></MemoryRouter>));
    },
    close: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test("Keep meeting cancels without changing either imported meeting", async () => {
  const f = await importedFixture();
  const view = detailHost();
  try {
    await view.render(libraryFor(f.items), f.tcw);
    await click("Delete meeting");
    await click("Keep meeting");
    // Vaul retains a closed drawer for its exit animation; it is no longer an open dialog.
    expect(Boolean(document.querySelector('[role="dialog"][data-state="open"]'))).toBe(false);
    expect(f.db.query("SELECT count(*) FROM connector_meeting").values()).toEqual([[2]]);
    expect(f.storage.deleteCalls).toBe(0);
    expect(f.kv.has(connectorStore.transcriptKvKey("granola", f.items[0]!.sourceId))).toBe(true);
  } finally {
    await view.close();
    f.db.close();
  }
});

test("storage failure leaves a retryable confirmation and does not claim deletion", async () => {
  const f = await importedFixture();
  const view = detailHost();
  let left = false;
  let refreshed = false;
  const library = libraryFor(f.items);
  library.refresh = () => { refreshed = true; };
  try {
    f.storage.failDelete = true;
    await view.render(library, f.tcw, () => { left = true; });
    await click("Delete meeting");
    await click("Delete meeting");
    await until(() => document.querySelector('[role="alert"]') !== null);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't delete this meeting. Try again.");
    expect(left || refreshed).toBe(false);
    expect(f.db.query("SELECT count(*) FROM connector_meeting").values()).toEqual([[2]]);
    expect(f.kv.has(connectorStore.transcriptKvKey("granola", f.items[0]!.sourceId))).toBe(true);
    f.storage.failDelete = false;
    await click("Delete meeting");
    await until(() => left && refreshed);
    expect(f.db.query("SELECT title FROM connector_meeting").values()).toEqual([["Other CSV meeting"]]);
  } finally {
    await view.close();
    f.db.close();
  }
});

test("Delete meeting requires loaded CSV metadata, Granola source, and a space-backed note", async () => {
  const f = await importedFixture();
  const view = detailHost();
  try {
    const selected = f.items[0]!;
    for (const library of [
      libraryFor([{ ...selected, source: "fireflies" }]),
      libraryFor([{ ...selected, onPhone: true }]),
      { ...libraryFor(f.items), note: { item: selected, audio: null, reads: {} } },
      { ...libraryFor(f.items), note: { item: selected, audio: null, reads: { metadata: { status: "ok" as const, metadata: {} } } } },
    ]) {
      await view.render(library, f.tcw);
      expect(button("Delete meeting")).toBeUndefined();
    }
    await view.render(libraryFor(f.items), f.tcw);
    expect(button("Delete meeting")).toBeDefined();
  } finally {
    await view.close();
    f.db.close();
  }
});

for (const change of ["selected meeting", "owner", "unmount"] as const) {
  test(`an in-flight delete cannot apply its success after ${change} changes`, async () => {
    const f = await importedFixture();
    const otherOwner = await importedFixture();
    const view = detailHost();
    const { promise, resolve } = Promise.withResolvers<void>();
    f.storage.waitForDelete = promise;
    let left = false;
    let refreshed = false;
    let closed = false;
    const library = libraryFor(f.items);
    library.refresh = () => { refreshed = true; };
    const events: unknown[] = [];
    const off = captureEvents.on("library-changed", detail => events.push(detail));
    try {
      await view.render(library, f.tcw, () => { left = true; });
      await click("Delete meeting");
      await click("Delete meeting");
      await until(() => f.storage.deleting);
      expect(button("Delete meeting")?.disabled).toBe(true);
      expect(button("Keep meeting")?.disabled).toBe(true);
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(Boolean(document.querySelector('[role="dialog"][data-state="open"]'))).toBe(true);
      if (change === "selected meeting") await view.render(libraryFor(f.items, f.items[1]!), f.tcw, () => { left = true; });
      if (change === "owner") await view.render(libraryFor(otherOwner.items), otherOwner.tcw, () => { left = true; });
      if (change === "unmount") { await view.close(); closed = true; }
      await act(async () => { resolve(); await runGranolaSpaceWrite(async () => {}); });
      await until(() => f.db.query("SELECT count(*) FROM connector_meeting").values()[0]?.[0] === 1);
      expect(left || refreshed).toBe(false);
      expect(events).toEqual([]);
      expect(f.storage.deleteCalls).toBe(1);
      expect(otherOwner.db.query("SELECT count(*) FROM connector_meeting").values()).toEqual([[2]]);
      if (!closed) expect(Boolean(document.querySelector('[role="dialog"][data-state="open"]'))).toBe(false);
    } finally {
      resolve();
      if (!closed) await view.close();
      off();
      f.db.close();
      otherOwner.db.close();
    }
  });
}

test("a deleted meeting and its combined copy stay evicted after a stale list and a local-cache write failure; explicit allow-back restores it", async () => {
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  resetLocalCacheForTests();
  const originalPut = IDBObjectStore.prototype.put;
  const f = await importedFixture();
  const first = f.items[0]!;
  const second = f.items[1]!;
  const combined = await combineMeetings(f.tcw, { source: "granola", sourceId: first.sourceId }, { source: "granola", sourceId: second.sourceId }, { force: true });
  expect(combined.ok && combined.data.status).toBe("written");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const { promise, resolve } = Promise.withResolvers<void>();
  const seen: Library[] = [];
  function Probe() {
    seen.push(useLibrary(f.tcw, { visible: true, noteId: first.id }));
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    await until(() => seen.at(-1)?.all.length === 3 && seen.at(-1)?.note.reads.transcript?.transcript.status === "ok" && !seen.at(-1)?.listing);
    const key = accountCacheKey(f.tcw.did!, "library");
    const cached = await readLocal<{ items: LibraryItem[] }>(key);
    expect(cached?.value.items.some(item => item.sourceId === first.sourceId)).toBe(true);
    f.storage.waitForList = promise;
    f.storage.listStarted = false;
    await act(async () => seen.at(-1)!.refresh());
    await until(() => f.storage.listStarted);
    // Complete the real storage delete while the previously captured list response is delayed.
    const deleted = await runGranolaSpaceWrite(() => connectorStore.deleteGranolaCsvMeeting(f.tcw, first.sourceId));
    expect(deleted.ok).toBe(true);
    IDBObjectStore.prototype.put = function () { throw new Error("local copy write unavailable"); };
    const deletedAt = seen.length;
    await act(async () => {
      captureEvents.emit("note-deleted", { source: "granola", sourceId: first.sourceId });
      captureEvents.emit("library-changed", { source: "granola", sourceId: first.sourceId });
    });
    expect(seen.at(-1)!.all.map(item => item.sourceId)).toEqual([second.sourceId]);
    expect(seen.at(-1)!.note.item).toBeNull();
    expect(seen.at(-1)!.note.reads).toEqual({});
    // Deleting the old account cache still works when replacing it fails.
    expect(await readLocal(key)).toBeNull();
    f.storage.waitForList = undefined;
    f.storage.failLists = true;
    await act(async () => { resolve(); });
    await until(() => !seen.at(-1)!.listing);
    expect(seen.at(-1)!.all.map(item => item.sourceId)).toEqual([second.sourceId]);
    expect(seen.slice(deletedAt).every(library => library.all.every(item => item.sourceId === second.sourceId))).toBe(true);
    expect(await readLocal(key)).toBeNull();
    IDBObjectStore.prototype.put = originalPut;
    expect((await connectorStore.clearGranolaDeletedMeetings(f.tcw)).ok).toBe(true);
    const reimported = await importGranolaCsv({ tcw: f.tcw, store: connectorStore, text: csv, checkPurge: async () => false });
    expect(reimported.ok && reimported.data.added).toBe(1);
    f.storage.failLists = false;
    await act(async () => seen.at(-1)!.refresh());
    await until(() => !seen.at(-1)!.listing && seen.at(-1)!.all.some(item => item.sourceId === first.sourceId));
    expect(seen.at(-1)!.all).toHaveLength(2);
  } finally {
    resolve();
    IDBObjectStore.prototype.put = originalPut;
    await act(async () => root.unmount());
    host.remove();
    f.db.close();
    resetLocalCacheForTests();
    if (previousIndexedDB) Object.defineProperty(globalThis, "indexedDB", previousIndexedDB);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("an old owner's confirmation queued behind sync never starts deleting after an account change", async () => {
  const f = await importedFixture();
  const otherOwner = await importedFixture();
  const view = detailHost();
  const { promise, resolve } = Promise.withResolvers<void>();
  const blocked = runGranolaSpaceWrite(() => promise);
  const events: unknown[] = [];
  const off = captureEvents.on("note-deleted", detail => events.push(detail));
  let left = false;
  let refreshed = false;
  const library = libraryFor(f.items);
  library.refresh = () => { refreshed = true; };
  try {
    await view.render(library, f.tcw, () => { left = true; });
    await click("Delete meeting");
    await click("Delete meeting");
    await view.render(libraryFor(otherOwner.items), otherOwner.tcw, () => { left = true; });
    await act(async () => { resolve(); await blocked; await runGranolaSpaceWrite(async () => {}); });
    expect(f.storage.deleteCalls).toBe(0);
    expect(f.db.query("SELECT count(*) FROM connector_meeting").values()).toEqual([[2]]);
    expect(otherOwner.db.query("SELECT count(*) FROM connector_meeting").values()).toEqual([[2]]);
    expect(f.kv.has(connectorStore.transcriptKvKey("granola", f.items[0]!.sourceId))).toBe(true);
    expect(left || refreshed).toBe(false);
    expect(events).toEqual([]);
    expect(Boolean(document.querySelector('[role="dialog"][data-state="open"]'))).toBe(false);
  } finally {
    resolve();
    await blocked;
    await view.close();
    off();
    f.db.close();
    otherOwner.db.close();
  }
});

test("late deletion evicts the original owner's cache without touching the current owner or another space", async () => {
  const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  resetLocalCacheForTests();
  const f = await importedFixture();
  const otherOwner = await importedFixture();
  const view = detailHost();
  const probeHost = document.body.appendChild(document.createElement("div"));
  const probeRoot = createRoot(probeHost);
  const { promise, resolve } = Promise.withResolvers<void>();
  f.storage.waitForDelete = promise;
  const originalKey = accountCacheKey(f.tcw.did!, "library");
  const currentKey = accountCacheKey(otherOwner.tcw.did!, "library");
  let left = false;
  const seen: Library[] = [];
  function CurrentOwner() {
    seen.push(useLibrary(otherOwner.tcw, { visible: true, noteId: otherOwner.items[0]!.id }));
    return null;
  }
  try {
    await writeLocal(originalKey, { items: f.items, previews: new Map() });
    await view.render(libraryFor(f.items), f.tcw, () => { left = true; });
    await click("Delete meeting");
    await click("Delete meeting");
    await until(() => f.storage.deleting);
    await view.render(libraryFor(otherOwner.items), otherOwner.tcw, () => { left = true; });
    await act(async () => probeRoot.render(<CurrentOwner />));
    await until(() => !seen.at(-1)!.listing && seen.at(-1)!.all.length === 2);
    expect((await readLocal<{ items: LibraryItem[] }>(currentKey))?.value.items).toHaveLength(2);
    const beforeLateResult = seen.length;
    await act(async () => {
      captureEvents.emit("note-deleted", {
        source: "granola", sourceId: otherOwner.items[0]!.sourceId,
        ownerDid: otherOwner.tcw.did, spaceId: f.tcw.spaceId,
      });
    });
    await act(async () => { resolve(); await runGranolaSpaceWrite(async () => {}); });
    await until(() => f.db.query("SELECT count(*) FROM connector_meeting").values()[0]?.[0] === 1);
    expect(await readLocal(originalKey)).toBeNull();
    expect((await readLocal<{ items: LibraryItem[] }>(currentKey))?.value.items).toHaveLength(2);
    expect(seen.at(-1)!.all).toHaveLength(2);
    expect(seen.slice(beforeLateResult).every(library => library.all.length === 2)).toBe(true);
    expect(left).toBe(false);
    expect(otherOwner.db.query("SELECT count(*) FROM connector_meeting").values()).toEqual([[2]]);
  } finally {
    resolve();
    await runGranolaSpaceWrite(async () => {});
    await view.close();
    await act(async () => probeRoot.unmount());
    probeHost.remove();
    f.db.close();
    otherOwner.db.close();
    resetLocalCacheForTests();
    if (previousIndexedDB) Object.defineProperty(globalThis, "indexedDB", previousIndexedDB);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
