import { Database } from "bun:sqlite";
import { webcrypto } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import * as store from "@/lib/connectors/connectorStore";
import { CONNECTORS } from "@/lib/connectors/registry";
import { connectorEnvelopeKvPath, connectorKeyPath } from "@/lib/connectors/namedConnectorSecrets";
import { _resetGmeetSyncSingleFlightForTests, isGmeetNotesSyncInFlight, syncGoogleMeet } from "@/lib/connectors/gmeetSync";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";

// Static import cannot work for the dialog: Radix captures DOM availability at
// module evaluation. Import it after installDom in this isolated process.
// No module mocking is used for the dialog, engine, client, store, or secrets.
const restoreImportDom = installDom();
const { ConnectorConnectDialog } = await import("@/chat/ConnectorDialog");
const { ConnectorsCard } = await import("@/chat/ConnectorsCard");

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

const NOTES_DOC_IDS = ["notes-1", "notes-2", "notes-3"];
const DOC_MIME = "application/vnd.google-apps.document";
/** 200 ordinary Docs and 3 Notes by Gemini Docs: the Drive of a user with a lot of Docs. */
function driveDocs() {
  const ordinary = Array.from({ length: 200 }, (_, i) => ({
    id: `budget-${i}`, name: `Budget review ${i}`, mimeType: DOC_MIME,
    createdTime: "2026-08-01T09:00:00.000Z", modifiedTime: "2026-08-01T09:00:00.000Z",
  }));
  const notes = NOTES_DOC_IDS.map((id, i) => ({
    id, name: `Atlas ${i + 1} - Notes by Gemini`, mimeType: DOC_MIME,
    createdTime: `2026-09-0${i + 1}T13:00:00.000Z`, modifiedTime: `2026-09-0${i + 1}T14:00:00.000Z`,
  }));
  return [...ordinary, ...notes];
}
function notesDocument(index: number) {
  const text = (content: string, style?: string) => ({ paragraph: {
    ...(style ? { paragraphStyle: { namedStyleType: style } } : {}), elements: [{ textRun: { content } }] } });
  return {
    documentId: NOTES_DOC_IDS[index], title: `Atlas ${index + 1} - Notes by Gemini`,
    body: { content: [
      text("Notes by Gemini\n", "TITLE"),
      text(`Atlas ${index + 1}\n`, "HEADING_1"),
      text(`September ${index + 1}, 2026, 9:00 AM -04:00 – 9:30 AM\n`),
      text("Summary\n", "HEADING_1"),
      text(`Synthetic summary ${index + 1}.\n`),
    ] },
  };
}

type Point = "drive-fetch" | "drive-body" | "docs-fetch" | "meet-entries" | "refresh" | "cursor-read" | "cursor-write" | "count" | "state";
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
  connectionReads = 0;
  refreshCalls = 0;
  popupCalls = 0;
  popupUrl = "";
  autojoinBeginState = "";
  readonly autojoinEnables: unknown[] = [];
  requireRefresh = false;
  /** Drive holds 200 non-notes Docs and 3 Notes by Gemini Docs (default: no Docs at all). */
  manyDocs = false;
  readonly docRequests: string[] = [];
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
          if (/FROM connector_state\b/i.test(sql) && params[0] === "google-meet") this.connectionReads++;
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
    keys: {
      ensureKey: async (_path: string) => undefined,
      encrypt: async (path: string, bytes: Uint8Array) => {
        const key = await webcrypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt"]);
        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
        return { v: 2, keyPath: path, iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") };
      },
      decrypt: async (envelope: { iv: string; ciphertext: string }) => {
        const key = await webcrypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["decrypt"]);
        const bytes = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") }, key, Buffer.from(envelope.ciphertext, "base64"));
        return new Uint8Array(bytes);
      },
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
    if (url.origin === backend && url.pathname === "/api/connectors/google/autojoin/begin" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      this.autojoinBeginState = body.state;
      return Response.json({ authorizationUrl: `https://accounts.example.invalid/authorize?state=${body.state}` });
    }
    if (url.origin === backend && url.pathname === "/api/connectors/google/autojoin/exchange" && method === "POST") {
      this.exchangeCalls++;
      return Response.json({ access_token: "synthetic-autojoin-access", refresh_token: "synthetic-autojoin-refresh",
        setupId: "s".repeat(43) });
    }
    if (url.origin === backend && url.pathname === "/api/connectors/google/autojoin/enable" && method === "POST") {
      this.autojoinEnables.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "on", enabled: true });
    }
    if (method !== "GET") return this.deny(url, method);
    if (url.origin === backend && url.pathname === "/api/connectors/google/autojoin/status") {
      return Response.json({ state: "off", enabled: false, offReason: "never_enabled", lastScanAt: null, errorCode: null, outcomes: [] });
    }
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
          await this.reach("meet-entries");
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
          const response = Response.json({ files: this.manyDocs ? driveDocs() : [] });
          const read = response.json.bind(response);
          response.json = async () => { await this.reach("drive-body"); return read(); };
          return response;
        }
        case "/drive/v3/changes":
          return Response.json({ changes: [], newStartPageToken: "synthetic-cursor" });
      }
    }
    if (url.origin === "https://docs.googleapis.com" && url.pathname.startsWith("/v1/documents/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/documents/".length));
      this.docRequests.push(id);
      await this.reach("docs-fetch");
      const index = NOTES_DOC_IDS.indexOf(id);
      if (index >= 0) return Response.json(notesDocument(index));
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
let heldCompletion: Gate | undefined;
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
function expectStoredCredential() {
  const written = memory.kv.get(connectorEnvelopeKvPath(descriptor));
  expect(written).toBeString();
  expect(JSON.parse(written!)).toMatchObject({ v: 2, keyPath: connectorKeyPath(descriptor) });
  for (const plaintext of ["synthetic-access", "synthetic-refresh", "synthetic-refreshed-access", "synthetic-autojoin-access", "synthetic-autojoin-refresh", "synthetic-first-access", "synthetic-session", "synthetic-authorization-code"]) {
    for (const value of memory.kv.values()) expect(value).not.toContain(plaintext);
  }
  expect(memory.secretWrites).toBe(0);
  expect(memory.tokens.size).toBe(0);
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
  window.location.href = "https://tinycloud.chat/chat/capture";
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
  heldCompletion = undefined;
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
      return heldCompletion?.promise;
    }} />));
  await settle();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  heldCompletion?.resolve();
  memory.dispose();
  await settle();
  // A deferred Notes reconcile outlives its dialog: let it finish before the DB closes.
  for (let attempt = 0; attempt < 40 && isGmeetNotesSyncInFlight(); attempt++) await settle();
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

test("N/N remains visibly Finishing through the final count and state awaits before Done, and a stalled Drive never gates Done", async () => {
  const drive = memory.hold("drive-fetch");
  const count = memory.hold("count");
  const state = memory.hold("state");
  await authorize();
  await until(() => memory.entered.has("count"), "expected final count");
  expectFinishing();
  expect(memory.savedMeeting()).toHaveLength(1);
  expect(memory.entered.has("drive-fetch")).toBe(false);
  count.resolve();
  await until(() => memory.entered.has("state"), "expected final state write");
  expectFinishing();
  state.resolve();
  await expectDone();
  expect(connectedCalls).toBe(1);
  expect((await store.getConnection(memory.tcw, "google-meet"))).toMatchObject({ ok: true, data: { lastSyncStatus: "ok", itemCount: 1 } });
  await until(() => memory.entered.has("drive-fetch"), "expected the background Notes reconcile to start after Done");
  expect(dialog().textContent).toContain("Notes by Gemini are still syncing in the background");
  drive.resolve();
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
      expectStoredCredential();
      expect(memory.secretUnlocks).toBe(0);
      expect(memory.tokens.size).toBe(0);
      expect(memory.popupCalls).toBe(1);
      expect(memory.exchangeCalls).toBe(1);
    });
  }
}

for (const point of ["count", "state"] as const) {
  test(`${point} timeout offers Retry; late completion cannot turn Error into Done`, async () => {
    const held = memory.hold(point);
    memory.requireRefresh = point === "refresh";
    await authorize(true);
    await until(() => memory.entered.has(point), `expected held ${point}`);
    expectFinishing();
    await act(async () => { vi.advanceTimersByTime(120_001); await tick(); });
    await settle();
    await act(async () => { vi.advanceTimersByTime(10_001); await tick(); }); // Row recovery wait for a held storage call.
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
    expectStoredCredential();
    expect(memory.popupCalls).toBe(1);
    expect(memory.exchangeCalls).toBe(1);
  });
}

test("one finishing deadline spans multiple final awaits rather than resetting per operation", async () => {
  const count = memory.hold("count");
  memory.hold("state");
  await authorize(true);
  await until(() => memory.entered.has("count"), "expected held final count");
  await act(async () => { vi.advanceTimersByTime(60_000); count.resolve(); await tick(); });
  await until(() => memory.entered.has("state"), "expected held final state write");
  expectFinishing();
  await act(async () => { vi.advanceTimersByTime(60_001); await tick(); });
  await settle();
  await act(async () => { vi.advanceTimersByTime(10_001); await tick(); }); // Row recovery wait for the held state write.
  await settle();
  expectErrorAndRetry();
});

for (const point of ["drive-fetch", "drive-body", "cursor-read", "cursor-write", "refresh"] as const) {
  for (const firstConnect of [false, true]) {
    test(`a stalled ${point} (${firstConnect ? "first connect" : "reconnect"}) leaves the connection saved and reaches Done without advancing the clock`, async () => {
      if (firstConnect) memory.db.run("DELETE FROM connector_state"); // The secret is saved, no connection row exists yet.
      memory.manyDocs = true;
      memory.requireRefresh = point === "refresh";
      memory.hold(point);
      await authorize(true);
      await expectDone();
      expect(dialog().textContent).toContain("Notes by Gemini are still syncing in the background");
      expect(button("Retry")).toBeUndefined();
      expect(connectedCalls).toBe(1);
      expect(await store.getConnection(memory.tcw, "google-meet")).toMatchObject({
        ok: true, data: { status: "connected", lastSyncStatus: "ok" },
      });
      expectStoredCredential();
      expect(memory.popupCalls).toBe(1);
    });
  }
}

test("when no connection row can be written the dialog says the connection was not saved and offers reconnecting, not Retry", async () => {
  memory.db.run("DELETE FROM connector_state");
  memory.failures.set("state", "result");
  await authorize();
  await until(() => memory.entered.has("state"), "expected the connection row write");
  await settle();
  expect(await store.getConnection(memory.tcw, "google-meet")).toMatchObject({ ok: true, data: null });
  const text = dialog().textContent!;
  expect(text).toContain("couldn’t save this connection");
  expect(text).toContain("Connect again");
  expect(text).not.toContain("are kept");
  expect(button("Retry")).toBeUndefined();
  expect(button("Close")).toBeTruthy();
  expect(text).not.toContain("Google Meet connected ·");
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
  expectStoredCredential();
  expect(memory.popupCalls).toBe(1);
  expect(memory.exchangeCalls).toBe(1);
});

for (const stop of ["unmount", "Stop sync"] as const) {
  test(`${stop} while Finishing prevents a late successful completion`, async () => {
    const held = memory.hold("count");
    await authorize();
    await until(() => memory.entered.has("count"), "expected post-loop work");
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

function startFirstFlight() {
  return syncGoogleMeet({
    client: new GmeetClient({ accessToken: "synthetic-first-access", fetchImpl: memory.fetch }),
    store,
    tcw: memory.tcw,
  });
}

for (const outcome of ["done", "error"] as const) {
  test(`a dialog joining a real flight refreshes the actual parent row exactly once on ${outcome}`, async () => {
    await act(async () => root!.unmount());
    memory.db.run("UPDATE connector_state SET status = 'disconnected' WHERE connector_id = 'google-meet'");
    root = createRoot(host!);
    await act(async () => root!.render(<MemoryRouter><ConnectorsCard tcw={memory.tcw} backendUrl={backend}
      sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore} /></MemoryRouter>));
    await until(() => Boolean(host!.querySelector('button[aria-label="Connect Google Meet"]')), "expected disconnected parent row");
    const row = [...host!.querySelectorAll<HTMLElement>('[data-testid="connector-row"]')]
      .find((entry) => entry.textContent?.includes("Google Meet"))!;
    expect(row.querySelector("[data-row-status]")?.textContent).toBe("Not connected");

    const drive = memory.hold("drive-fetch");
    if (outcome === "error") memory.failures.set("count", "reject");
    const first = startFirstFlight();
    try {
      await until(() => memory.entered.has("drive-fetch"), "expected first flight held after its record loop");
      const readsBeforeDialog = memory.connectionReads;
      await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Connect Google Meet"]')!.click());
      await authorize();
      await until(() => memory.kv.has(connectorEnvelopeKvPath(descriptor)), "expected the second dialog to save its connection and join");
      expectStoredCredential();
      expect(memory.recordListings).toBe(1);
      expect(row.querySelector("[data-row-status]")?.textContent).toBe("Not connected");
      await act(async () => {
        drive.resolve();
        expect((await first).ok).toBe(outcome === "done");
        await tick();
      });
      if (outcome === "done") await expectDone();
      else {
        await settle();
        expectErrorAndRetry();
      }
      await until(() => row.querySelector("[data-row-status]")?.textContent === (outcome === "done" ? "Connected" : "Last sync failed"),
        "expected the joined dialog to refresh the persisted parent row");
      if (outcome === "done") expect(row.textContent).toContain("1 meeting");
      expect(memory.connectionReads).toBe(readsBeforeDialog + 1);
      expect(memory.savedMeeting()).toHaveLength(1);
      await click("Close");
      await settle();
      expect(memory.connectionReads).toBe(readsBeforeDialog + 1);
    } finally {
      drive.resolve();
      await first;
    }
  });
}

for (const caller of ["owner", "joiner"] as const) {
  test(`${caller} completion notification runs once and times out to Retry without late Done`, async () => {
    vi.useFakeTimers();
    fakeClockActive = true;
    heldCompletion = deferred();
    // A joined flight is the only path whose Drive phase still gates the shared result
    // (the first caller did not defer Notes); the owner's Drive runs after Done.
    const drive = memory.hold("drive-fetch");
    const first = caller === "joiner" ? startFirstFlight() : undefined;
    try {
      if (first) await until(() => memory.entered.has("drive-fetch"), "expected an existing flight");
      await authorize();
      await until(() => (first ? memory.entered.has("drive-fetch") : true) && memory.kv.has(connectorEnvelopeKvPath(descriptor)), "expected authorized dialog");
      expectStoredCredential();
      await act(async () => {
        drive.resolve();
        if (first) expect((await first).ok).toBe(true);
        await tick();
      });
      await until(() => connectedCalls === 1, "expected exactly one bounded parent notification");
      expect(document.body.textContent).not.toContain("Google Meet connected ·");
      await act(async () => { vi.advanceTimersByTime(120_001); await tick(); });
      await settle();
      expectErrorAndRetry();
      await act(async () => { heldCompletion!.resolve(); await tick(); });
      await settle();
      expectErrorAndRetry();
      expect(connectedCalls).toBe(1);
      heldCompletion = undefined;
      await click("Retry");
      await expectDone();
      expect(connectedCalls).toBe(2);
      expectStoredCredential();
    } finally {
      drive.resolve();
      heldCompletion?.resolve();
      await first;
    }
  });
}

test("a joined flight with a throwing parent notification settles to Error and notifies only once", async () => {
  const drive = memory.hold("drive-fetch");
  const first = startFirstFlight();
  throwOnConnected = true;
  try {
    await until(() => memory.entered.has("drive-fetch"), "expected an existing flight");
    await authorize();
    await act(async () => {
      drive.resolve();
      expect((await first).ok).toBe(true);
      await tick();
    });
    await settle();
    expectErrorAndRetry();
    expect(connectedCalls).toBe(1);
    expect(memory.savedMeeting()).toHaveLength(1);
  } finally {
    drive.resolve();
    await first;
  }
});

// ── Deferred Notes by Gemini: progress, log, background reconcile ──────────

function progressValue() {
  const bar = dialog().querySelector('[role="progressbar"]');
  expect(bar, `missing progressbar; DOM=${dialog().innerHTML}`).toBeTruthy();
  expect(bar!.getAttribute("aria-valuemin")).toBe("0");
  expect(bar!.getAttribute("aria-valuemax")).toBe("100");
  return Number(bar!.getAttribute("aria-valuenow"));
}
function stubClipboard() {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { copied.push(text); },
  } });
  return copied;
}
type CopiedLog = {
  generatedAt: string;
  timeline: { tMs: number; stage: string; meetingsChecked: number; meetingsTotal: number | null; notesDone: number | null;
    notesTotal: number | null; docsListed: number | null; docsMatched: number | null }[];
  diagnostics: Record<string, number | string> | null;
  phaseTimingsMs: Record<string, number> | null;
  result: { kind: string; connectionSaved: boolean | null; notesDeferred: boolean } | null;
  notesOutcome: { ok: boolean; errorKind: string | null } | null;
};
async function copyLog(copied: string[]): Promise<{ text: string; log: CopiedLog }> {
  const before = copied.length;
  await click("Copy sync log");
  await until(() => copied.length === before + 1, "expected the sync log on the clipboard");
  return { text: copied[before]!, log: JSON.parse(copied[before]!) as CopiedLog };
}
const NEVER_IN_LOG = ["synthetic-access", "synthetic-refresh", "synthetic-session", "Synthetic person", "Synthetic saved transcript",
  "synthetic-record", "Atlas", "Budget review", "Synthetic summary", "Bearer"];

async function mountCardAndConnect() {
  await act(async () => root!.unmount());
  memory.db.run("UPDATE connector_state SET status = 'disconnected' WHERE connector_id = 'google-meet'");
  root = createRoot(host!);
  await act(async () => root!.render(<MemoryRouter><ConnectorsCard tcw={memory.tcw} backendUrl={backend}
    sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore} /></MemoryRouter>));
  await until(() => Boolean(host!.querySelector('button[aria-label="Connect Google Meet"]')), "expected disconnected parent row");
  const row = [...host!.querySelectorAll<HTMLElement>('[data-testid="connector-row"]')]
    .find((entry) => entry.textContent?.includes("Google Meet"))!;
  const status = () => row.querySelector("[data-row-status]")?.textContent;
  await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Connect Google Meet"]')!.click());
  return { row, status };
}

test("with 200 Docs in Drive the dialog reaches Done in a few ticks without advancing the clock, and Notes carry on in the background", async () => {
  memory.manyDocs = true;
  const docs = memory.hold("docs-fetch");
  await authorize(true);
  await expectDone(); // Polls microtask ticks only: no 60 s / 120 s fake-timer advance.
  expect(dialog().textContent).toContain("Meetings are saved. Notes by Gemini are still syncing in the background; you can close this.");
  expect(connectedCalls).toBe(1);
  expect(button("Retry")).toBeUndefined();
  await until(() => memory.entered.has("docs-fetch"), "expected the background reconcile to read a Notes Doc");
  // Live counts reach the open Done panel from the background reconcile.
  await until(() => /203 Docs listed/.test(dialog().textContent!) && /3 matched/.test(dialog().textContent!),
    "expected the Done panel to show Docs listed / matched");
  docs.resolve();
  await until(() => /finished syncing/.test(dialog().textContent!), "expected the Done panel to report the settled reconcile");
  expect(dialog().textContent).not.toContain("still syncing");
  expect(memory.savedMeeting()).toHaveLength(4);
  expect(memory.docRequests.sort()).toEqual(["notes-1", "notes-2", "notes-3"]); // None of the 200 ordinary Docs is read.
});

test("the bar and counts follow the sync: the meeting total shows at once, the bar rises per stage, and elapsed seconds tick", async () => {
  const entries = memory.hold("meet-entries");
  const state = memory.hold("state");
  await authorize(true);
  await until(() => memory.entered.has("meet-entries"), "expected the record loop to be checking a meeting");
  expect(dialog().textContent).toContain("1 meeting found");
  expect(dialog().textContent).toContain("Checking 0/1 meetings…");
  const checking = progressValue();
  await act(async () => { entries.resolve(); await tick(); });
  await until(() => memory.entered.has("state"), "expected the final state write");
  expectFinishing();
  expect(dialog().textContent).toContain("Step: Saving sync state");
  const saving = progressValue();
  expect(saving).toBeGreaterThan(checking);
  expect(saving).not.toBe(33);
  expect(checking).toBeLessThan(40);
  await act(async () => { vi.advanceTimersByTime(3_000); await tick(); });
  expect(dialog().textContent).toMatch(/Elapsed [3-9]s/);
  state.resolve();
  await expectDone();
});

test("Copy sync log copies the stage timeline, counters and result as JSON, while Finishing and after Done, with no secret or title text", async () => {
  memory.manyDocs = true;
  const copied = stubClipboard();
  const state = memory.hold("state");
  memory.hold("docs-fetch");
  await authorize(true);
  await until(() => memory.entered.has("state"), "expected the final state write");
  expectFinishing();
  const finishing = await copyLog(copied);
  expect(finishing.log.result).toBeNull();
  expect(finishing.log.timeline.map((entry) => entry.stage)).toContain("meetings");
  expect(finishing.log.timeline.at(-1)).toMatchObject({ meetingsChecked: 1, meetingsTotal: 1 });
  expect(dialog().textContent).toContain("Sync log copied.");
  state.resolve();
  await expectDone();
  await until(() => memory.entered.has("docs-fetch"), "expected the background reconcile");
  await until(() => /Notes 0\/3/.test(dialog().textContent!), "expected Notes counts from the background reconcile");
  const done = await copyLog(copied);
  expect(Date.parse(done.log.generatedAt)).not.toBeNaN();
  expect(done.log.result).toEqual({ kind: "ok", connectionSaved: true, notesDeferred: true });
  expect(done.log.timeline.map((entry) => entry.stage)).toEqual(expect.arrayContaining(["meetings", "saving", "notes"]));
  expect(done.log.timeline.find((entry) => entry.stage === "notes")).toMatchObject({ notesTotal: 3, docsListed: 203, docsMatched: 3 });
  expect(done.log.timeline.map((entry) => entry.tMs)).toEqual([...done.log.timeline.map((entry) => entry.tMs)].sort((a, b) => a - b));
  expect(done.log.diagnostics).toBeTruthy();
  expect(Object.keys(done.log.phaseTimingsMs ?? {}).length).toBeGreaterThan(0);
  for (const { text } of [finishing, done]) for (const secret of NEVER_IN_LOG) expect(text).not.toContain(secret);
});

test("Copy sync log says so inline when the browser has no clipboard", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  memory.hold("state");
  await authorize(true);
  await until(() => memory.entered.has("state"), "expected the final state write");
  await click("Copy sync log");
  expect(dialog().textContent).toContain("Clipboard isn’t available");
});

test("Copy sync log is offered on error and carries the error kind, not its message", async () => {
  const copied = stubClipboard();
  memory.failures.set("state", "result");
  await authorize();
  await until(() => memory.entered.has("state"), "expected the state write");
  await settle();
  expectErrorAndRetry();
  const { text, log } = await copyLog(copied);
  expect(log.result).toMatchObject({ kind: "storage", notesDeferred: false });
  expect(text).not.toContain("failed synthetically");
});

test("closing the dialog right after Done does not stop the Notes reconcile, and the card row re-reads when it settles", async () => {
  memory.manyDocs = true;
  const docs = memory.hold("docs-fetch");
  const { row, status } = await mountCardAndConnect();
  await authorize();
  await expectDone();
  await until(() => status() === "Connected" && row.textContent!.includes("1 meeting"), "expected the dialog's onConnected to refresh the row");
  await until(() => memory.entered.has("docs-fetch"), "expected the background reconcile");
  await click("Close");
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(isGmeetNotesSyncInFlight()).toBe(true);
  expect(row.textContent).toContain("1 meeting"); // Still the pre-Notes count.
  docs.resolve();
  await until(() => row.textContent!.includes("4 meetings"), "expected the card row to re-read the settled reconcile");
  expect(memory.savedMeeting()).toHaveLength(4);
  expect(status()).toBe("Connected");
});

test("a background Notes failure after the dialog closed surfaces on the card as Last sync failed with the saved message", async () => {
  memory.manyDocs = true;
  const docs = memory.hold("docs-fetch");
  const { row, status } = await mountCardAndConnect();
  await authorize();
  await expectDone();
  await until(() => status() === "Connected", "expected the dialog's onConnected to refresh the row");
  await until(() => memory.entered.has("docs-fetch"), "expected the background reconcile");
  await click("Close");
  await settle();
  expect(row.querySelector('[role="alert"]')).toBeNull();
  memory.failures.set("docs-fetch", "reject");
  docs.resolve();
  await until(() => status() === "Last sync failed", "expected the card row to show the background failure");
  const saved = await store.getConnection(memory.tcw, "google-meet");
  expect(saved).toMatchObject({ ok: true, data: { status: "connected", lastSyncStatus: "error" } });
  const message = (saved as { data: { lastSyncError: string } }).data.lastSyncError;
  expect(message.length).toBeGreaterThan(0);
  expect(row.querySelector('[role="alert"]')?.textContent).toBe(message);
});


test("Calendar autojoin enables from the server credential: no Meet secret write, no Meet sync, Meet connection untouched", async () => {
  let closed = 0;
  await act(async () => root!.render(<ConnectorConnectDialog tcw={memory.tcw} descriptor={descriptor} backendUrl={backend}
    purpose="autojoin"
    sessionStore={{ getToken: () => "synthetic-session", isExpired: () => false } as unknown as SessionStore}
    open onOpenChange={(next) => { if (!next) closed++; }} onConnected={() => { connectedCalls++; }} />));
  await settle();
  const consent = dialog().querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(consent).toBeTruthy();
  await act(async () => { consent!.click(); await tick(); });
  await click("Continue with Google");
  await until(() => memory.popupUrl.length > 0 && memory.autojoinBeginState.length > 0, "expected the autojoin authorization URL");
  expect(memory.popupUrl).toContain("accounts.example.invalid");
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", {
      origin: backend,
      data: { code: "synthetic-authorization-code", state: memory.autojoinBeginState },
    }));
    await tick();
  });
  await until(() => closed === 1, "expected the dialog to close once autojoin is enabled");
  expect(memory.autojoinEnables).toEqual([{ setupId: "s".repeat(43) }]);
  expect(connectedCalls).toBe(1);
  expect(memory.secretWrites).toBe(0);
  expect(memory.secretUnlocks).toBe(0);
  expect(memory.tokens.size).toBe(0);
  expect(memory.kv.has(connectorEnvelopeKvPath(descriptor))).toBe(false);
  expect(memory.recordListings).toBe(0);
  expect(memory.requests.some((request) => /googleapis\.com/.test(request.url))).toBe(false);
  expect(await store.getConnection(memory.tcw, "google-meet")).toMatchObject({
    ok: true, data: { status: "connected", lastSyncedAt: oldWatermark, itemCount: 0 },
  });
});
