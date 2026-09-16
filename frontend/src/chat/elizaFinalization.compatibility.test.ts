/**
 * Controlled frontend completion proof: installed assistant-ui runtime → real
 * history adapter → normal SQL writer, using SQLite :memory:. The extraction
 * callback seam invokes real runExtraction with a controlled completion. This
 * does not mount the React hook or call an Eliza/provider/production endpoint.
 */
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { createChatModelAdapter, type AdapterDeps } from "./chatModelAdapter";
import { createMeetingMessageRegistry, takePendingCompletion, takePendingReceipt } from "./pendingHandoff";
import { getCompletion, onCompletion } from "../lib/completionStore";
import { getToolActivity, onToolActivityChange } from "../lib/toolActivityStore";
import { getMemory, setMemory, memoryWriteGen } from "../lib/threadStore";
import { MEMORY_TEMPLATE, renderMemoryBlock, runExtraction } from "../lib/memory";

const initialFetch = globalThis.fetch;
const initialWarn = console.warn;
const initialHTMLElement = globalThis.HTMLElement;
const initialCustomElements = globalThis.customElements;
afterEach(() => {
  globalThis.fetch = initialFetch;
  console.warn = initialWarn;
  if (initialHTMLElement) globalThis.HTMLElement = initialHTMLElement;
  else delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  if (initialCustomElements) globalThis.customElements = initialCustomElements;
  else delete (globalThis as { customElements?: typeof customElements }).customElements;
});

async function until(check: () => boolean) {
  for (let tick = 0; tick < 200 && !check(); tick++) await Bun.sleep(2);
  expect(check()).toBe(true);
}
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const RAW_CANARY = "SYNTHETIC_RAW_TOOL_DATA_MUST_NOT_PERSIST";

for (const composite of [false, true]) {
  test(`${composite ? "composite" : "ordinary"} completion persists and extracts once, with no early verification handoff`, async () => {
    // The SDK import needs only these custom-element names; no DOM renderer.
    globalThis.HTMLElement ??= class {} as never;
    globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
    const { createHistoryAdapter } = await import("./runtime");
    const frontendRequire = createRequire(new URL("../../package.json", import.meta.url));
    const reactRequire = createRequire(frontendRequire.resolve("@assistant-ui/react"));
    const { LocalThreadRuntimeCore } = await import(reactRequire.resolve("@assistant-ui/core/internal"));
    const sqlite = new Database(":memory:");
    const operations: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: never[] = []) => ({ ok: true, data: { rows: sqlite.query(sql).values(...params) } }),
      execute: async (sql: string, params: never[] = []) => {
        operations.push({ sql, params });
        sqlite.query(sql).run(...params);
        return { ok: true, data: { rows: [] } };
      },
      batch: async (batch: Array<{ sql: string; params?: never[] }>) => {
        sqlite.transaction(() => {
          for (const operation of batch) {
            operations.push({ sql: operation.sql, params: operation.params ?? [] });
            sqlite.query(operation.sql).run(...(operation.params ?? []));
          }
        })();
        return { ok: true, data: { rows: [] } };
      },
    };
    // Deliberately do not useLocalThreadStorage: this exercises normal SQL code.
    const tcw = { did: `did:test:completion:${crypto.randomUUID()}`, sql: { db: () => db } } as unknown as TinyCloudWeb;
    const model = OFFERED_CHAT_MODELS[0].id;
    const threadId = `controlled-${composite ? "composite" : "ordinary"}`;
    const registry = createMeetingMessageRegistry();
    let origin: any;
    let appendSaved = false;
    let releaseAppend!: () => void;
    const appended = new Promise<void>(resolve => { releaseAppend = resolve; });
    const selection = {
      beginTurn: async (_thread: string, turnId: string) => origin = { tcw, threadId, model, turnId, activation: 1, space: "controlled", signal: new AbortController().signal },
      beginActiveTurn: async () => origin,
      getView: () => ({ threadId, model }),
      waitForAppend: async () => appended,
      confirmAppend: () => { appendSaved = true; releaseAppend(); },
      isAppendSaved: () => appendSaved,
      captureCancel: () => () => {}, assertActive: () => {}, setRunning: () => {},
      needsFirstInsert: () => true, markFirstAppend: () => {},
    } as unknown as AdapterDeps["selection"];
    const extractionCalls: unknown[] = [];
    const extractionInputs: unknown[] = [];
    const extractionWork: Promise<void>[] = [];
    const completionEvents: unknown[] = [];
    const activityEvents: unknown[] = [];
    const logs: unknown[] = [];
    const nextMemory = `${MEMORY_TEMPLATE}\n- Prefers concise controlled-test answers.`;
    await setMemory(tcw, MEMORY_TEMPLATE);
    operations.length = 0;
    const history = createHistoryAdapter(tcw, threadId, selection as never, (exchange, turn, captured) => {
      extractionCalls.push({ exchange, turn, model: captured.model });
      extractionWork.push(runExtraction(exchange, {
        complete: async messages => { extractionInputs.push(messages); return nextMemory; },
        getDoc: () => getMemory(captured.tcw), setDoc: next => setMemory(captured.tcw, next), writeGen: memoryWriteGen,
      }));
    }, undefined, registry);
    const unsubscribeCompletion = onCompletion((id, ref) => completionEvents.push({ id, ref }));
    const unsubscribeActivity = onToolActivityChange((_id, activity) => activityEvents.push(activity));
    const payloads: Array<{ model: string; roomId: string; messages: Array<{ role: string; content: string }> }> = [];
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://synthetic.invalid/api/agent/chat");
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    }) as typeof fetch;
    console.warn = (...args) => { logs.push(args); };
    const adapter = createChatModelAdapter({
      backendUrl: "https://synthetic.invalid", sessionStore: { getToken: () => "controlled-token" } as never,
      selection, agentEnabledRef: { current: true }, meetingMessageRegistry: registry,
      privateAccessRef: { current: { active: true, revision: "test-revision", generation: 0 } },
    });
    const runtime = new LocalThreadRuntimeCore({ getModelContext: () => ({ system: renderMemoryBlock(MEMORY_TEMPLATE) }) }, {
      adapters: { chatModel: adapter, history: { ...history, load: async () => ({ messages: [] }) } },
    });
    const encoder = new TextEncoder();
    const rows = () => sqlite.query("SELECT payload FROM messages WHERE thread_id = ? ORDER BY position").values(threadId).map(row => JSON.parse(String(row[0])));
    try {
      runtime.composer.setText("A controlled question.");
      await runtime.composer.send();
      await until(() => Boolean(stream));
      // A received provider ID is still ineligible for a badge before DONE.
      stream.enqueue(encoder.encode(frame({ ...(composite ? {} : { id: "controlled-provider-id" }), choices: [{ delta: { content: "Checking. " } }] })));
      await until(() => runtime.messages.at(-1)?.content.some((part: any) => part.text === "Checking. "));
      const assistantId = runtime.messages.at(-1).id;
      expect(getCompletion(assistantId)).toBeUndefined();
      expect(takePendingCompletion(assistantId)).toBeNull();
      expect(extractionCalls).toHaveLength(0);
      expect(rows().map(item => item.message.role)).toEqual(["user"]);
      // Compatibility only: unknown raw result fields are discarded by the
      // frontend. The real backend is separately required never to emit them.
      stream.enqueue(encoder.encode(frame({ tool_activity: { name: "tinycloud_read_meeting", status: "running", data: RAW_CANARY },
        privateDraft: RAW_CANARY, choices: [{ delta: { tool_calls: [{ function: { arguments: RAW_CANARY } }] } }] }) +
        frame({ choices: [{ delta: { content: "Controlled final answer." } }] }) +
        frame({ usage: { prompt_tokens: 3, completion_tokens: 4 } }) +
        frame({ usage: { prompt_tokens: 7, completion_tokens: 8 } }) +
        "data: [DONE]\n\ndata: [DONE]\n\n"));
      stream.close();
      await until(() => extractionCalls.length > 0);
      await Promise.all(extractionWork);
      const stored = rows();
      expect(stored.map(item => item.message.role)).toEqual(["user", "assistant"]);
      expect(stored[1].message.content).toEqual([{ type: "text", text: "Checking. Controlled final answer." }]);
      expect(stored[1].message.status.type).toBe("complete");
      expect(extractionCalls).toHaveLength(1);
      expect(extractionInputs).toHaveLength(1);
      expect(JSON.stringify(extractionInputs)).toContain("Checking. Controlled final answer.");
      expect(operations.filter(operation => /INSERT INTO memory/.test(operation.sql) && operation.params[0] === "user_context")).toHaveLength(1);
      expect(await getMemory(tcw)).toBe(nextMemory);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({ model, roomId: threadId });
      expect(payloads[0]!.messages.filter(message => message.content.includes("<user_memory>")).length).toBe(1);
      expect(sqlite.query("SELECT model FROM threads WHERE id = ?").values(threadId)[0]![0]).toBe(model);
      expect(takePendingReceipt(assistantId)).toEqual({ modelId: model, usage: { promptTokens: 7, completionTokens: 8 } });
      expect(takePendingReceipt(assistantId)).toBeNull();
      expect(takePendingCompletion(assistantId)).toBeNull();
      expect(completionEvents).toHaveLength(composite ? 0 : 1);
      expect(getCompletion(assistantId)).toEqual(composite ? undefined : { model, completionId: "controlled-provider-id" });
      expect(getToolActivity(assistantId)).toBeNull();
      expect(JSON.stringify({ stored, extractionCalls, extractionInputs, activityEvents, logs })).not.toContain(RAW_CANARY);
    } finally {
      unsubscribeCompletion(); unsubscribeActivity(); sqlite.close();
    }
  });
}
