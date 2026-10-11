// Mounted sync: triggers share one pass, and locked secrets do not erase the
// baseline of meetings already in Library when the provider first appeared.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { captureEvents } from "@/capture/captureEvents";
import { notifySecretsUnlockedForTests } from "@/lib/connectors/connectorSecrets";
import { setSecretsAvailableForTests } from "@/lib/openkeyNative";
import type { TranscriberClient } from "@/lib/transcriberApi";
import { TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { useTranscriberLibrarySync, type TranscriberLibrarySaver } from "./useTranscriberLibrarySync";

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
    listSaved: async () => ({ ok: true, data: [...savedIds] }),
    save: async () => ({ ok: true }),
  };
  const client = {
    list: async () => ({ status: "ok", value: { meetings: rows } }),
    transcript: async () => ({ status: "error" }),
  } as unknown as TranscriberClient;
  return { tcw, sessionStore, identity, secrets, savedIds, rows, saver, client, backendUrl: "https://example.test" };
}

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
  const changes: string[] = [];
  const unsubscribe = captureEvents.on("library-changed", (detail) => changes.push(detail?.sourceId ?? ""));
  try {
    await mount(f);
    await started.promise;
    f.identity.address = "0xaccount-b";
    pending.resolve({ ok: true });
    await act(async () => {});
    expect(changes).toEqual([]);
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
