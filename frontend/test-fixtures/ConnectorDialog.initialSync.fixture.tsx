import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import * as store from "@/lib/connectors/connectorStore";
import { CONNECTORS } from "@/lib/connectors/registry";
import { _resetGmeetSyncSingleFlightForTests } from "@/lib/connectors/gmeetSync";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";

// Static import cannot work for the dialog: Radix captures DOM availability at
// module evaluation. Import it after installDom in this isolated process.
// No module mocking is used for the dialog, engine, client, store, or secrets.
const restoreImportDom = installDom();
const { ConnectorConnectDialog } = await import("@/chat/ConnectorDialog");

const descriptor = CONNECTORS.find((entry) => entry.id === "google-meet")!;
const backend = "https://synthetic-oauth.invalid";
const oldWatermark = "2026-10-01T00:00:00.000Z";
const recordName = "conferenceRecords/synthetic-record";
const transcriptName = `${recordName}/transcripts/synthetic-transcript`;
const participantName = `${recordName}/participants/synthetic-person`;
const realFetch = globalThis.fetch;
const tick = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    channel.port2.close();
    resolve();
  };
  channel.port2.postMessage(null);
});

type Point = "drive-fetch" | "drive-body" | "refresh" | "cursor-read" | "cursor-write" | "count" | "state";
type Failure = "reject" | "result";
type SdkError = { code: string; message: string };
type SdkResult<T> = { ok: true; data: T } | { ok: false; error: SdkError };
type Gate = { promise: Promise<void>; resolve: () => void };
const ok = <T,>(data: T): SdkResult<T> => ({ ok: true, data });

function deferred(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class MemoryBoundaries {
  readonly db = new Database(":memory:");
  readonly kv = new Map<string, string>();
  readonly tokens = new Map<string, string>();
  readonly entered = new Set<Point>();
  readonly gates = new Map<Point, Gate>();
  readonly allGates = new Set<Gate>();
  readonly failures = new Map<Point, Failure>();
  readonly unexpectedEgress: string[] = [];
  readonly requests: { url: string; method: string }[] = [];
  secretWrites = 0;
  secretUnlocks = 0;
  exchangeCalls = 0;
  recordListings = 0;
  refreshCalls = 0;
  popupCalls = 0;
  popupUrl = "";
  requireRefresh = false;
  private refreshed = false;

  hold(point: Point) {
    const gate = deferred();
    this.gates.set(point, gate);
    this.allGates.add(gate);
    return gate;
  }

  async reach(point: Point): Promise<SdkError | null> {
    this.entered.add(point);
    const gate = this.gates.get(point);
    this.gates.delete(point); // A Retry uses the same storage, not the old hold.
    if (gate) await gate.promise;
    const failure = this.failures.get(point);
    this.failures.delete(point);
    const error = { code: "SYNTHETIC_FAILURE", message: `${point} failed synthetically` };
    if (failure === "reject") throw new Error(error.message);
    return failure === "result" ? error : null;
  }

  readonly tcw = {
    did: `did:example:mounted-dialog-${crypto.randomUUID()}`,
    spaceId: `mounted-dialog-${crypto.randomUUID()}`,
    sql: {
      db: () => ({
        query: async (sql: string, params: SQLQueryBindings[] = []) => {
          if (/SELECT COUNT\(\*\) FROM connector_meeting/i.test(sql)) {
            const error = await this.reach("count");
            if (error) return { ok: false, error };
          }
          return ok({ rows: this.db.query(sql).values(...params) });
        },
        execute: async (sql: string, params: SQLQueryBindings[] = []) => {
          if (/INSERT INTO connector_state/i.test(sql)) {
            const error = await this.reach("state");
            if (error) return { ok: false, error };
          }
          const result = this.db.query(sql).run(...params);
          return ok({ changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) });
        },
      }),
    },
    kv: {
      get: async (key: string) => {
        if (key === store.driveCursorKvKey("google-meet")) await this.reach("cursor-read");
        return this.kv.has(key)
          ? ok({ data: this.kv.get(key), headers: {} })
          : { ok: false, error: { code: "KV_NOT_FOUND", message: "Synthetic missing key" } };
      },
      put: async (key: string, value: unknown) => {
        if (key === store.driveCursorKvKey("google-meet")) await this.reach("cursor-write");
        this.kv.set(key, typeof value === "string" ? value : JSON.stringify(value));
        return ok({ data: undefined, headers: {} });
      },
      delete: async (key: string) => { this.kv.delete(key); return ok(undefined); },
      list: async ({ path }: { path: string }) => ok({ keys: [...this.kv.keys()].filter((key) => key.startsWith(path)), truncated: false }),
    },
    secrets: {
      isUnlocked: true,
      unlock: async () => { this.secretUnlocks++; return ok(undefined); },
      put: async (name: string, value: string, options?: { scope?: string }) => {
        this.secretWrites++;
        this.tokens.set(`${options?.scope ?? ""}:${name}`, value);
        return ok(undefined);
      },
      get: async (name: string, options?: { scope?: string }) => {
        const value = this.tokens.get(`${options?.scope ?? ""}:${name}`);
        return value ? ok(value) : { ok: false, error: { code: "NOT_FOUND", message: "Synthetic missing token" } };
      },
      delete: async (name: string, options?: { scope?: string }) => {
        this.tokens.delete(`${options?.scope ?? ""}:${name}`);
        return ok(undefined);
      },
    },
  } as unknown as TinyCloudWeb;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    this.requests.push({ url: url.toString(), method });
    if (url.origin === backend && url.pathname === "/api/connectors/google/oauth/exchange" && method === "POST") {
      this.exchangeCalls++;
      const body = JSON.parse(String(init?.body));
      expect(body.code).toBe("synthetic-authorization-code");
      expect(body.verifier).toBeString();
      expect(body.verifier.length).toBeGreaterThan(0);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-session");
      return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
    }
    if (url.origin === backend && url.pathname === "/api/connectors/google/oauth/refresh" && method === "POST") {
      this.refreshCalls++;
      await this.reach("refresh");
      this.refreshed = true;
      return Response.json({ access_token: "synthetic-refreshed-access" });
    }
    if (method !== "GET") return this.deny(url, method);
    if (url.origin === "https://meet.googleapis.com") {
      switch (url.pathname) {
        case "/v2/conferenceRecords":
          this.recordListings++;
          return Response.json({ conferenceRecords: [{ name: recordName, startTime: "2026-10-15T12:00:00Z", endTime: "2026-10-15T12:01:00Z" }] });
        case `/v2/${recordName}/participants`:
          return Response.json({ participants: [{ name: participantName, signedinUser: { displayName: "Synthetic person" } }] });
        case `/v2/${recordName}/transcripts`:
          return Response.json({ transcripts: [{ name: transcriptName, state: "ENDED" }] });
        case `/v2/${transcriptName}/entries`:
          return Response.json({ transcriptEntries: [{ name: `${transcriptName}/entries/1`, participant: participantName,
            text: "Synthetic saved transcript", startTime: "2026-10-15T12:00:00Z", endTime: "2026-10-15T12:00:05Z" }] });
      }
    }
    if (url.origin === "https://www.googleapis.com") {
      switch (url.pathname) {
        case "/drive/v3/changes/startPageToken":
          return Response.json({ startPageToken: "synthetic-cursor" });
        case "/drive/v3/files": {
          if (this.requireRefresh && !this.refreshed) return Response.json({ error: { message: "Synthetic expired access" } }, { status: 401 });
          await this.reach("drive-fetch");
          const response = Response.json({ files: [] });
          const read = response.json.bind(response);
          response.json = async () => { await this.reach("drive-body"); return read(); };
          return response;
        }
        case "/drive/v3/changes":
          return Response.json({ changes: [], newStartPageToken: "synthetic-cursor" });
      }
    }
    return this.deny(url, method);
  }) as typeof fetch;

  private deny(url: URL, method: string): never {
    this.unexpectedEgress.push(`${method} ${url}`);
    throw new Error(`Unexpected synthetic network request: ${method} ${url}`);
  }

  savedMeeting() {
    return this.db.query("SELECT id, created_at, source_id, summary_overview, summary_action_items FROM connector_meeting").values();
  }

  dispose() {
    for (const gate of this.allGates) gate.resolve();
  }
}

let memory: MemoryBoundaries;
let restoreDom: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let connectedCalls = 0;
let throwOnConnected = false;
let fakeClockActive = false;
let restoreOpen: (() => void) | undefined;

async function settle() {
  await act(async () => { await tick(); await tick(); });
}
async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 40 && !predicate(); attempt++) await settle();
  expect(predicate(), `${message}; DOM=${document.body.innerHTML}`).toBe(true);
}
function dialog() {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(node).toBeTruthy();
  return node!;
}
function button(label: string) {
  return [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label);
}
async function click(label: string) {
  const target = button(label);
  expect(target, `missing ${label}; DOM=${dialog().innerHTML}`).toBeTruthy();
  expect(target!.disabled).toBe(false);
  await act(async () => { target!.click(); await tick(); });
  await settle();
}
function expectFinishing() {
  expect(dialog().textContent).toMatch(/finishing/i);
  const progress = dialog().querySelector('[role="progressbar"]');
  expect(progress).toBeTruthy();
  expect(dialog().textContent).not.toContain("Google Meet connected ·");
  expect(connectedCalls).toBe(0);
}
function expectErrorAndRetry() {
  expect(dialog().textContent).toMatch(/failed|error|could|couldn|timed.?out|timeout/i);
  expect(dialog().textContent).not.toContain("Google Meet connected ·");
  expect(button("Retry")).toBeTruthy();
  expect(button("Continue with Google")).toBeUndefined();
}
async function expectDone() {
  await until(() => dialog().textContent!.includes("Google Meet connected ·"), "expected successful completion");
  expect(dialog().textContent).not.toMatch(/finishing/i);
  expect(button("Retry")).toBeUndefined();
}
async function authorize(fakeClock = false) {
  await click("Continue with Google");
  await until(() => memory.popupUrl.length > 0, "expected synthetic popup start URL");
  const url = new URL(memory.popupUrl);
  expect(url.origin).toBe(backend);
  expect(url.pathname).toBe("/api/connectors/google/oauth/start");
  expect(url.searchParams.get("challenge")).toBeTruthy();
  const state = url.searchParams.get("state");
  expect(state).toBeTruthy();
  if (fakeClock) {
    vi.useFakeTimers();
    fakeClockActive = true;
  }
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", {
      origin: backend,
      data: { code: "synthetic-authorization-code", state },
    }));
    await tick();
  });
  await settle();
}

beforeEach(async () => {
  restoreDom = installDom();
  memory = new MemoryBoundaries();
  globalThis.fetch = memory.fetch;
  // No pass-through to browser networking, including during synthetic OAuth.
  window.fetch = memory.fetch;
  const previousOpen = Object.getOwnPropertyDescriptor(window, "open");
  Object.defineProperty(window, "open", { configurable: true, value: () => {
    memory.popupCalls++;
    const popup = { closed: false, close() { this.closed = true; }, location: {} };
    Object.defineProperty(popup.location, "href", { set(value: string) { memory.popupUrl = value; } });
    return popup;
  } });
  restoreOpen = () => {
    if (previousOpen) Object.defineProperty(window, "open", previousOpen);
    else Reflect.deleteProperty(window, "open");
  };
  connectedCalls = 0;
  throwOnConnected = false;
  expect((await store.ensureSchema(memory.tcw)).ok).toBe(true);
  expect((await store.updateSyncState(memory.tcw, { connectorId: "google-meet", status: "connected", lastSyncedAt: oldWatermark,
    lastSyncStatus: "ok", lastSyncError: null, itemCount: 0 })).ok).toBe(true);
  memory.entered.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConnectorConnectDialog tcw={memory.tcw} descriptor={descriptor} backendUrl={backend}
    sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore}
    open onOpenChange={() => {}} onConnected={() => {
      connectedCalls++;
      if (throwOnConnected) throw new Error("completion failed synthetically");
    }} />));
  await settle();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  memory.dispose();
  await settle();
  host?.remove();
  host = undefined;
  if (fakeClockActive) {
    vi.clearAllTimers();
    vi.useRealTimers();
    fakeClockActive = false;
  }
  globalThis.fetch = realFetch;
  restoreOpen?.();
  restoreOpen = undefined;
  restoreDom?.();
  restoreDom = undefined;
  memory.db.close();
  _resetGmeetSyncSingleFlightForTests();
  store._resetConnectorSchemaMemoForTests();
  __resetStorageStatusForTests();
  expect(memory.unexpectedEgress).toEqual([]);
});
afterAll(() => restoreImportDom());

test("N/N remains visibly Finishing through Drive, cursor, count and final state awaits before Done", async () => {
  const drive = memory.hold("drive-fetch");
  const cursor = memory.hold("cursor-write");
  const count = memory.hold("count");
  const state = memory.hold("state");
  await authorize();
  await until(() => memory.entered.has("drive-fetch"), "expected post-loop Drive work");
  expectFinishing();
  expect(memory.savedMeeting()).toHaveLength(1);
  drive.resolve();
  await until(() => memory.entered.has("cursor-write"), "expected cursor persistence");
  expectFinishing();
  cursor.resolve();
  await until(() => memory.entered.has("count"), "expected final count");
  expectFinishing();
  count.resolve();
  await until(() => memory.entered.has("state"), "expected final state write");
  expectFinishing();
  state.resolve();
  await expectDone();
  expect(connectedCalls).toBe(1);
  expect((await store.getConnection(memory.tcw, "google-meet"))).toMatchObject({ ok: true, data: { lastSyncStatus: "ok", itemCount: 1 } });
});

for (const point of ["count", "state"] as const) {
  for (const failure of ["reject", "result"] as const) {
    test(`${point} ${failure} is visible Error with same-connection Retry, not Done or reauthorization`, async () => {
      memory.failures.set(point, failure);
      await authorize();
      await until(() => memory.entered.has(point), `expected ${point}`);
      await settle();
      expectErrorAndRetry();
      // Model Notes already saved by another import before the in-dialog Retry.
      // They must survive the transcript re-sweep on this same connection.
      memory.db.query("UPDATE connector_meeting SET summary_overview = ?, summary_action_items = ?")
        .run("Synthetic saved Notes", JSON.stringify(["Synthetic saved action"]));
      const saved = memory.savedMeeting();
      expect(saved).toHaveLength(1);
      const transcriptKey = store.transcriptKvKey("google-meet", "synthetic-record");
      const transcript = memory.kv.get(transcriptKey);
      expect(transcript).toContain("Synthetic saved transcript");
      expect((await store.getConnection(memory.tcw, "google-meet"))).toMatchObject({ ok: true, data: { status: "connected", lastSyncedAt: oldWatermark } });
      await click("Retry");
      await expectDone();
      expect(memory.recordListings).toBe(2);
      expect(memory.savedMeeting()).toEqual(saved);
      expect(memory.kv.get(transcriptKey)).toBe(transcript);
      expect(memory.secretWrites).toBe(1);
      expect(memory.secretUnlocks).toBe(0);
      expect(memory.tokens.get("google-meet:REFRESH_TOKEN")).toBe("synthetic-refresh");
      expect(memory.popupCalls).toBe(1);
      expect(memory.exchangeCalls).toBe(1);
    });
  }
}

for (const point of ["drive-fetch", "drive-body", "refresh", "cursor-read", "cursor-write", "count", "state"] as const) {
  test(`${point} timeout offers Retry; late completion cannot turn Error into Done`, async () => {
    const held = memory.hold(point);
    memory.requireRefresh = point === "refresh";
    await authorize(true);
    await until(() => memory.entered.has(point), `expected held ${point}`);
    expectFinishing();
    await act(async () => { vi.advanceTimersByTime(120_001); await tick(); });
    await settle();
    expectErrorAndRetry();
    expect(connectedCalls).toBeLessThanOrEqual(1);
    const notificationsAtTimeout = connectedCalls;
    held.resolve();
    await settle();
    expectErrorAndRetry();
    expect(connectedCalls).toBe(notificationsAtTimeout);
    await click("Retry");
    await expectDone();
    expect(memory.recordListings).toBe(2);
    expect(memory.secretWrites).toBe(1);
    expect(memory.popupCalls).toBe(1);
    expect(memory.exchangeCalls).toBe(1);
  });
}

test("one finishing deadline spans multiple final awaits rather than resetting per operation", async () => {
  const drive = memory.hold("drive-body");
  memory.hold("count");
  await authorize(true);
  await until(() => memory.entered.has("drive-body"), "expected held Drive response body");
  await act(async () => { vi.advanceTimersByTime(60_000); drive.resolve(); await tick(); });
  await until(() => memory.entered.has("count"), "expected held final count");
  expectFinishing();
  await act(async () => { vi.advanceTimersByTime(60_001); await tick(); });
  await settle();
  expectErrorAndRetry();
});

test("a throwing onConnected completion callback becomes visible Error with Retry, not a stranded initial-sync", async () => {
  throwOnConnected = true;
  await authorize();
  await until(() => connectedCalls === 1, "expected completion callback");
  await settle();
  expectErrorAndRetry();
  throwOnConnected = false;
  await click("Retry");
  await expectDone();
  expect(memory.secretWrites).toBe(1);
  expect(memory.popupCalls).toBe(1);
  expect(memory.exchangeCalls).toBe(1);
});

for (const stop of ["unmount", "Stop sync"] as const) {
  test(`${stop} while Finishing prevents a late successful completion`, async () => {
    const held = memory.hold("drive-fetch");
    await authorize();
    await until(() => memory.entered.has("drive-fetch"), "expected post-loop work");
    expectFinishing();
    if (stop === "unmount") {
      await act(async () => root!.unmount());
      root = undefined;
    } else {
      await click("Stop sync");
    }
    held.resolve();
    await settle();
    expect(document.body.textContent).not.toContain("Google Meet connected ·");
    if (stop === "unmount") expect(connectedCalls).toBe(0);
  });
}
