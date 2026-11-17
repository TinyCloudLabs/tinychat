/**
 * The image mark survives a reload because it is derived from the stored history: the installed assistant-ui runtime
 * drives the real chat adapter and the real history adapter over SQLite :memory:; a reload then reads the stored
 * messages back with nothing remembered in the page.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { createChatModelAdapter } from "./chatModelAdapter";
import { ModelSelectionCoordinator } from "./modelSelection";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import { isConversationMarked, notePastedText, resetImageGateForTests } from "../lib/imageGate";
import { historyPrefetch, setPrefetchFetcher } from "../lib/historyPrefetch";
import { getThread } from "../lib/threadStore";

const initialFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = initialFetch;
  resetImageGateForTests();
  historyPrefetch.clear();
  setPrefetchFetcher(async () => null);
});

const CHOSEN = OFFERED_CHAT_MODELS[1].id;
const until = async (check: () => boolean) => {
  for (let tick = 0; tick < 500 && !check(); tick++) await Bun.sleep(2);
  expect(check()).toBe(true);
};

async function converse(threadId: string, pasted: boolean) {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { createHistoryAdapter } = await import("./runtime");
  const frontendRequire = createRequire(new URL("../../package.json", import.meta.url));
  const reactRequire = createRequire(frontendRequire.resolve("@assistant-ui/react"));
  const { LocalThreadRuntimeCore } = await import(reactRequire.resolve("@assistant-ui/core/internal"));

  const sqlite = new Database(":memory:");
  const db = {
    query: async (sql: string, params: never[] = []) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
    execute: async (sql: string, params: never[] = []) => { sqlite.query(sql).run(...params); return { ok: true, data: { changes: 1 } }; },
    batch: async (statements: Array<{ sql: string; params?: never[] }>) => {
      sqlite.transaction(() => { for (const statement of statements) sqlite.query(statement.sql).run(...(statement.params ?? [])); })();
      return { ok: true, data: { results: [] } };
    },
  };
  const tcw = { did: `did:test:image-gate:${crypto.randomUUID()}`, sql: { db: () => db } } as unknown as TinyCloudWeb;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/api/chat/model-selection")) return Response.json({ model: CHOSEN, reason: "healthy" });
    return new Response(
      `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "Hi there" } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  const sessionStore = { getToken: () => "token", isExpired: () => false, clear: () => {} } as never;
  const selection = new ModelSelectionCoordinator({ tcw, backendUrl: "https://synthetic.invalid", sessionStore, onView: () => {} });
  selection.activate(threadId, "new");
  const registry = createMeetingMessageRegistry();
  const history = createHistoryAdapter(tcw, threadId, selection, () => {}, undefined, registry);
  const chatModel = createChatModelAdapter({
    backendUrl: "https://synthetic.invalid", sessionStore, selection, agentEnabledRef: { current: false },
    meetingMessageRegistry: registry, privateAccessRef: { current: { active: false, revision: "off", generation: 0 } },
  } as never);
  const runtime = new LocalThreadRuntimeCore({ getModelContext: () => ({}) }, {
    adapters: { chatModel, history: { ...history, load: async () => ({ messages: [] }) } },
  });
  const stored = () => {
    try {
      return sqlite.query("SELECT payload FROM messages WHERE thread_id = ? ORDER BY position").values(threadId)
        .map((row) => JSON.parse(String(row[0])) as { provenance?: { v: number; outside: boolean }; message: { role: string } });
    } catch { return []; } // the table is created by the first write
  };

  if (pasted) notePastedText();
  runtime.composer.setText("hello");
  void runtime.composer.send();
  await until(() => stored().length === 2);
  const reload = async () => {
    resetImageGateForTests(); // nothing is remembered in the page
    historyPrefetch.clear();
    setPrefetchFetcher((id) => getThread(tcw, id));
    const fresh = createHistoryAdapter(tcw, threadId, selection, () => {}, undefined, registry);
    await fresh.load();
  };
  return { stored, reload, close: () => { selection.dispose(); sqlite.close(); } };
}

test("a conversation that took in pasted text stores its mark on every message and is marked again after a reload", async () => {
  const chat = await converse("thread-pasted", true);
  try {
    expect(chat.stored().map((item) => item.provenance)).toEqual([{ v: 1, outside: true }, { v: 1, outside: true }]);
    await chat.reload();
    expect(isConversationMarked("thread-pasted")).toBe(true);
  } finally { chat.close(); }
});

test("a conversation of only typed text stays unmarked after a reload", async () => {
  const chat = await converse("thread-typed", false);
  try {
    expect(chat.stored().map((item) => item.provenance)).toEqual([{ v: 1, outside: false }, { v: 1, outside: false }]);
    await chat.reload();
    expect(isConversationMarked("thread-typed")).toBe(false);
  } finally { chat.close(); }
});
