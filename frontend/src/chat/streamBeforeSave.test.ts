/**
 * Stream-before-save: the installed assistant-ui runtime driving the real chat
 * adapter, the real ModelSelectionCoordinator, the real history adapter and
 * the normal SQL writer (SQLite :memory:). The first token must not wait for
 * the user message's save; the reply must still persist only after it.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { createChatModelAdapter } from "./chatModelAdapter";
import { ModelSelectionCoordinator } from "./modelSelection";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import { appendMessage } from "../lib/threadStore";

const initialFetch = globalThis.fetch;
const initialHTMLElement = globalThis.HTMLElement;
const initialCustomElements = globalThis.customElements;
afterEach(() => {
  globalThis.fetch = initialFetch;
  if (initialHTMLElement) globalThis.HTMLElement = initialHTMLElement;
  else delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  if (initialCustomElements) globalThis.customElements = initialCustomElements;
  else delete (globalThis as { customElements?: typeof customElements }).customElements;
});

async function until(check: () => boolean) {
  for (let tick = 0; tick < 300 && !check(); tick++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

type Gate = { entered: Promise<void>; release: () => void };
const encoder = new TextEncoder();
const chunk = (text: string) =>
  encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
const delta = (text: string) =>
  encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: text } }] })}\n\n`);
const CHOSEN = OFFERED_CHAT_MODELS[1].id;
const isMessageInsert = (statements: Array<{ sql: string }>) =>
  statements.some((statement) => /INSERT INTO messages/.test(statement.sql));

async function harness(kind: "new" | "existing") {
  globalThis.HTMLElement ??= class {} as never;
  globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
  const { createHistoryAdapter } = await import("./runtime");
  const frontendRequire = createRequire(new URL("../../package.json", import.meta.url));
  const reactRequire = createRequire(frontendRequire.resolve("@assistant-ui/react"));
  const { LocalThreadRuntimeCore } = await import(reactRequire.resolve("@assistant-ui/core/internal"));

  const sqlite = new Database(":memory:");
  let beforeInsert: (() => Promise<{ ok: false; error: { code: string; message: string } } | void>) | null = null;
  const db = {
    query: async (sql: string, params: never[] = []) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
    execute: async (sql: string, params: never[] = []) => {
      sqlite.query(sql).run(...params);
      return { ok: true, data: { changes: 1 } };
    },
    batch: async (statements: Array<{ sql: string; params?: never[] }>) => {
      if (beforeInsert && isMessageInsert(statements)) {
        const hook = beforeInsert;
        beforeInsert = null;
        const failure = await hook();
        if (failure) return failure;
      }
      sqlite.transaction(() => {
        for (const statement of statements) sqlite.query(statement.sql).run(...(statement.params ?? []));
      })();
      return { ok: true, data: { results: [] } };
    },
  };
  const tcw = { did: `did:test:stream-before-save:${crypto.randomUUID()}`, sql: { db: () => db } } as unknown as TinyCloudWeb;
  const threadId = `thread-${kind}`;
  if (kind === "existing") {
    await appendMessage(tcw, threadId, { message: { id: "old", role: "user", content: [{ type: "text", text: "old" }] } } as never, CHOSEN);
  }

  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/chat/model-selection")) return Response.json({ model: CHOSEN, reason: "healthy" });
    expect(url).toBe("https://synthetic.invalid/api/chat");
    return new Response(new ReadableStream({
      start(controller) {
        streams.push(controller);
        // Like a real fetch, an abort errors the body being read.
        init?.signal?.addEventListener("abort", () => {
          try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* closed */ }
        }, { once: true });
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const sessionStore = { getToken: () => "token", isExpired: () => false, clear: () => {} } as never;
  const selection = new ModelSelectionCoordinator({
    tcw, backendUrl: "https://synthetic.invalid", sessionStore, onView: () => {},
  });
  selection.activate(threadId, kind);
  const registry = createMeetingMessageRegistry();
  const history = createHistoryAdapter(tcw, threadId, selection, () => {}, undefined, registry);
  const chatModel = createChatModelAdapter({
    backendUrl: "https://synthetic.invalid", sessionStore, selection,
    agentEnabledRef: { current: false }, meetingMessageRegistry: registry,
    privateAccessRef: { current: { active: false, revision: "off", generation: 0 } },
  } as never);
  // assistant-ui fires a user message's history.append without awaiting it
  // (so a failed save is an unhandled rejection in the app, unchanged here).
  // Observe those promises so the tests can assert on them.
  const appendErrors: unknown[] = [];
  const observed = {
    ...history,
    load: async () => ({ messages: [] }),
    append: (item: Parameters<typeof history.append>[0]) => {
      const appended = history.append(item);
      appended.catch((error) => { appendErrors.push(error); });
      return appended;
    },
  };
  const runtime = new LocalThreadRuntimeCore({ getModelContext: () => ({}) }, {
    adapters: { chatModel, history: observed },
  });

  const rows = () => sqlite.query("SELECT payload FROM messages WHERE thread_id = ? ORDER BY position")
    .values(threadId)
    .map((row) => JSON.parse(String(row[0])).message as { role: string; status?: { type: string }; content: Array<{ text: string }> })
    .map((message) => ({ role: message.role, text: message.content.map((part) => part.text).join(""), status: message.status?.type }));
  const last = () => runtime.messages.at(-1) as { status: { type: string; reason?: string; error?: string }; content: Array<{ type: string; text?: string }> };
  const lastText = () => last()?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
  const holdInsert = (failure?: { code: string; message: string }): Gate => {
    let entered!: () => void;
    let release!: () => void;
    const gate = {
      entered: new Promise<void>((resolve) => { entered = resolve; }),
      release: () => release(),
    };
    beforeInsert = async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return failure ? { ok: false as const, error: failure } : undefined;
    };
    return gate;
  };
  // composer.send() does not wait for the run; tests observe state instead.
  const send = (text: string) => {
    runtime.composer.setText(text);
    void runtime.composer.send();
  };
  const model = () => sqlite.query("SELECT model FROM threads WHERE id = ?").values(threadId)[0]?.[0];
  return { runtime, selection, streams, rows, last, lastText, holdInsert, send, model, appendErrors, close: () => sqlite.close() };
}

test("a new chat streams before its first message is saved; the reply persists after it with the chosen model", async () => {
  const h = await harness("new");
  try {
    const insert = h.holdInsert();
    h.send("hello");
    await insert.entered;
    // The user INSERT is still in flight, and the inference request is out.
    await until(() => h.streams.length === 1);
    expect(h.rows()).toEqual([]);

    h.streams[0]!.enqueue(chunk("Hi there"));
    h.streams[0]!.close();
    await until(() => h.lastText() === "Hi there");
    await Bun.sleep(20);
    // The turn stays open (composer locked) until its prompt is durable, and
    // the reply has not jumped ahead of it.
    expect(h.last().status.type).toBe("running");
    expect(h.rows()).toEqual([]);

    insert.release();
    await until(() => h.rows().length === 2);
    expect(h.last().status).toEqual({ type: "complete", reason: "unknown" });
    expect(h.rows()).toEqual([
      { role: "user", text: "hello", status: undefined },
      { role: "assistant", text: "Hi there", status: "complete" },
    ]);
    expect(h.model()).toBe(CHOSEN);
    await until(() => h.selection.getView().canSend);
    expect(h.selection.getView()).toMatchObject({ model: CHOSEN, saving: false, saveFailed: false });
  } finally {
    h.selection.dispose();
    h.close();
  }
});

test("Stop mid-stream is immediate while the prompt is unsaved; the partial reply and the next turn persist after it, in order", async () => {
  const h = await harness("existing");
  try {
    await until(() => h.selection.getView().canSend);
    const insert = h.holdInsert();
    h.send("first");
    await insert.entered;
    await until(() => h.streams.length === 1);
    h.streams[0]!.enqueue(delta("Partial"));
    await until(() => h.lastText() === "Partial");

    h.runtime.cancelRun();
    await until(() => h.last().status.type === "incomplete");
    expect(h.last().status).toMatchObject({ type: "incomplete", reason: "cancelled" });
    expect(h.rows().map((row) => row.text)).toEqual(["old"]);

    // The next turn starts while the first prompt's save is still held. Its
    // stream is not blocked, and its writes queue behind the first turn's.
    h.send("second");
    await until(() => h.streams.length === 2);
    h.streams[1]!.enqueue(chunk("Second reply"));
    h.streams[1]!.close();
    await until(() => h.lastText() === "Second reply");
    expect(h.rows().map((row) => row.text)).toEqual(["old"]);

    insert.release();
    await until(() => h.rows().length === 5);
    expect(h.rows()).toEqual([
      { role: "user", text: "old", status: undefined },
      { role: "user", text: "first", status: undefined },
      { role: "assistant", text: "Partial", status: "incomplete" },
      { role: "user", text: "second", status: undefined },
      { role: "assistant", text: "Second reply", status: "complete" },
    ]);
  } finally {
    h.selection.dispose();
    h.close();
  }
});

test("a prompt that fails to save surfaces on the streamed reply and leaves no orphaned reply", async () => {
  const h = await harness("existing");
  try {
    await until(() => h.selection.getView().canSend);
    const insert = h.holdInsert({ code: "SQL", message: "write refused" });
    h.send("doomed");
    await insert.entered;
    await until(() => h.streams.length === 1);
    h.streams[0]!.enqueue(chunk("Streamed anyway"));
    h.streams[0]!.close();
    await until(() => h.lastText() === "Streamed anyway");
    insert.release();
    await until(() => h.last().status.type === "incomplete");
    expect(h.last().status).toEqual({ type: "incomplete", reason: "error", error: "Message not saved." });
    expect(h.lastText()).toBe("Streamed anyway");
    await Bun.sleep(20);
    expect(h.rows().map((row) => row.text)).toEqual(["old"]);
    expect(h.appendErrors).toHaveLength(1);
    expect(String(h.appendErrors[0])).toContain("write refused");
  } finally {
    h.selection.dispose();
    h.close();
  }
});

test("waitForAppend has a deadline and honours an abort signal", async () => {
  const sqlite = new Database(":memory:");
  const db = {
    query: async (sql: string, params: never[] = []) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
    execute: async (sql: string, params: never[] = []) => { sqlite.query(sql).run(...params); return { ok: true, data: {} }; },
    batch: async (statements: Array<{ sql: string; params?: never[] }>) => {
      for (const statement of statements) sqlite.query(statement.sql).run(...(statement.params ?? []));
      return { ok: true, data: {} };
    },
  };
  const tcw = { did: `did:test:deadline:${crypto.randomUUID()}`, sql: { db: () => db } } as unknown as TinyCloudWeb;
  await appendMessage(tcw, "deadline", { message: { id: "old", role: "user", content: [] } } as never, CHOSEN);
  const selection = new ModelSelectionCoordinator({
    tcw, backendUrl: "https://unused.test", sessionStore: { getToken: () => "t" } as never, onView: () => {},
  });
  try {
    selection.activate("deadline", "existing");
    const origin = await selection.beginTurn("deadline", "turn");
    await expect(selection.waitForAppend(origin, { timeoutMs: 20 })).rejects.toThrow("Message save timed out.");
    const stop = new AbortController();
    const aborted = selection.waitForAppend(origin, { signal: stop.signal });
    stop.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");
    selection.confirmAppend(origin, true);
    await expect(selection.waitForAppend(origin, { timeoutMs: 20 })).resolves.toBeUndefined();
  } finally {
    selection.dispose();
    sqlite.close();
  }
});
