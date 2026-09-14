import { expect, test } from "bun:test";

// A child process observes real dropped composer promises without installing a
// rejection handler in product code or interfering with Bun's own test runner.
// Resolve the core actually installed for @assistant-ui/react, through its
// exported internal seam, rather than a workstation path or a second runtime.
test("installed composer recovers from agent failures with no unhandled rejection and keeps Stop cancelled", async () => {
  const script = String.raw`
    import { strict as assert } from "node:assert";
    import { createRequire } from "node:module";
    import { createChatModelAdapter } from "./frontend/src/chat/chatModelAdapter.ts";
    import { createTurnOutcomeStore, takePendingReceipt, takePendingCompletion } from "./frontend/src/chat/pendingHandoff.ts";
    import { getToolActivity } from "./frontend/src/lib/toolActivityStore.ts";
    const frontendRequire = createRequire(new URL("./frontend/package.json", import.meta.url));
    const reactRequire = createRequire(frontendRequire.resolve("@assistant-ui/react"));
    const { LocalThreadRuntimeCore } = await import(reactRequire.resolve("@assistant-ui/core/internal"));
    const frame = (value) => "data: " + JSON.stringify(value) + "\n\n";
    const encoder = new TextEncoder();
    const unhandled = [];
    const listener = (error) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    const results = [];
    try {
      for (const failure of ["fetch", "read", "eof", "turn_timeout", "cancel", "success"]) {
        let requests = 0;
        let reads = 0;
        let activeSignal;
        let readStarted;
        const waiting = new Promise((resolve) => { readStarted = resolve; });
        let cancelled = 0;
        globalThis.fetch = async (url, init) => {
          assert.equal(String(url), "https://synthetic.invalid/api/agent/chat");
          assert.equal(init.method, "POST");
          requests++;
          activeSignal = init.signal;
          if (failure === "fetch") throw new TypeError("PRIVATE FETCH SENTINEL");
          return new Response(new ReadableStream({
            pull(controller) {
              if (reads++ === 0) controller.enqueue(encoder.encode(
                frame({ tool_activity: { name: "web_search", status: "running" } }) +
                frame({ id: "synthetic-completion", choices: [{ delta: { content: "Synthetic intro." } }] }) +
                frame({ usage: { prompt_tokens: 1, completion_tokens: 2 } })
              ));
              else if (failure === "read") controller.error(new TypeError("PRIVATE READ SENTINEL"));
              else if (failure === "cancel") readStarted();
              else {
                if (failure === "turn_timeout") controller.enqueue(encoder.encode(frame({ stream_error: { code: "turn_timeout" }, choices: [{ delta: { content: "legacy notice" } }] })));
                if (failure === "success" || failure === "turn_timeout") controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
            },
            cancel() { cancelled++; },
          }));
        };
        const running = [];
        const persisted = [];
        const origin = { threadId: "synthetic-thread", model: "synthetic-model", turnId: "synthetic-turn", signal: new AbortController().signal };
        const adapter = createChatModelAdapter({
          sessionStore: { getToken: () => "synthetic-token" }, backendUrl: "https://synthetic.invalid",
          agentEnabledRef: { current: true }, turnOutcomes: createTurnOutcomeStore(),
          selection: { captureCancel: () => () => {}, beginActiveTurn: async () => origin,
            waitForAppend: async () => {}, assertActive: () => {}, setRunning: (_origin, value) => running.push(value) },
        });
        const runtime = new LocalThreadRuntimeCore({ getModelContext: () => ({}) }, {
          adapters: { chatModel: adapter, history: { load: async () => ({ messages: [] }), append: async (item) => { persisted.push(item); } } },
        });
        runtime.composer.setText("synthetic question");
        await runtime.composer.send();
        if (failure === "cancel") {
          await waiting;
          // ReadableStream may prefetch before the runtime has rendered the
          // previous chunk. Exercise Stop after visible partial text.
          for (let tick = 0; tick < 100 && !runtime.messages.at(-1)?.content.some((part) => part.type === "text" && part.text); tick++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          runtime.cancelRun();
        }
        for (let tick = 0; tick < 100 && running.at(-1) !== false; tick++) await new Promise((resolve) => setTimeout(resolve, 5));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const message = runtime.messages.at(-1);
        const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
        const receipt = takePendingReceipt(message.id);
        const completion = takePendingCompletion(message.id);
        runtime.composer.setText("next synthetic question");
        results.push({ failure, unhandled: unhandled.length, status: message.status, content, running, requests,
          canSend: runtime.composer.canSend, activity: getToolActivity(message.id), receipt, completion,
          aborted: activeSignal?.aborted ?? false, cancelled,
          persistedStatus: persisted.find((item) => item.message.role === "assistant")?.message.status,
        });
        unhandled.length = 0;
      }
      console.log(JSON.stringify(results));
    } finally { process.off("unhandledRejection", listener); }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
    cwd: new URL("../../..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const results = JSON.parse(stdout);
  expect(results).toHaveLength(6);
  for (const result of results) {
    expect(result.unhandled).toBe(0);
    expect(result.running).toEqual([true, false]);
    expect(result.requests).toBe(1);
    expect(result.canSend).toBe(true);
    expect(result.activity).toBeNull();
    expect({ failure: result.failure, content: result.content }).toEqual({
      failure: result.failure, content: result.failure === "fetch" ? "" : "Synthetic intro.",
    });
    const status = result.failure === "success" ? { type: "complete", reason: "unknown" }
      : result.failure === "cancel" ? { type: "incomplete", reason: "cancelled" }
        : { type: "incomplete", reason: "error", error: result.failure === "turn_timeout"
          ? "This reply took too long to finish. You can try again."
          : "The connection ended before the reply finished. You can try again." };
    expect(result.status).toEqual(status);
    expect(result.persistedStatus).toEqual(status);
    if (result.failure === "success") {
      expect(result.receipt).toMatchObject({ usage: { promptTokens: 1, completionTokens: 2 } });
      expect(result.completion).toMatchObject({ completionId: "synthetic-completion" });
    } else {
      expect(result.receipt).toBeNull();
      expect(result.completion).toBeNull();
    }
    if (result.failure === "cancel") {
      expect(result.aborted).toBe(true);
      expect(result.cancelled).toBe(1);
    }
  }
}, 5000);


test("Stop before request or adapter startup persists one cancelled terminal after the pending user write", async () => {
  const script = String.raw`
    import { createRequire } from "node:module";
    import { Database } from "bun:sqlite";
    import { createChatModelAdapter } from "./frontend/src/chat/chatModelAdapter.ts";
    import { createTurnOutcomeStore } from "./frontend/src/chat/pendingHandoff.ts";
    import { ModelSelectionCoordinator } from "./frontend/src/chat/modelSelection.ts";
    import { getThread } from "./frontend/src/lib/threadStore.ts";
    globalThis.HTMLElement ??= class {};
    globalThis.customElements ??= { define() {}, get() {}, getName() {}, upgrade() {}, whenDefined: async () => {} };
    const { createHistoryAdapter } = await import("./frontend/src/chat/runtime.tsx");
    const frontendRequire = createRequire(new URL("./frontend/package.json", import.meta.url));
    const reactRequire = createRequire(frontendRequire.resolve("@assistant-ui/react"));
    const { LocalThreadRuntimeCore } = await import(reactRequire.resolve("@assistant-ui/core/internal"));
    const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
    const results = [];
    for (const beforeAdapter of [false, true]) {
      const db = new Database(":memory:");
      const writeStarted = pause(), writeReady = pause(), adapterReady = pause();
      let firstWrite = true, requests = 0, extraction = 0;
      const sql = {
        query: async (sql, params = []) => ({ ok: true, data: { rows: db.query(sql).values(...params) } }),
        execute: async (sql, params = []) => { db.query(sql).run(...params); return { ok: true, data: { rows: [] } }; },
        batch: async statements => {
          if (firstWrite) { firstWrite = false; writeStarted.resolve(); await writeReady.promise; }
          db.transaction(() => { for (const statement of statements) db.query(statement.sql).run(...(statement.params ?? [])); })();
          return { ok: true, data: { rows: [] } };
        },
      };
      const tcw = { did: "did:synthetic:" + crypto.randomUUID(), spaceId: "synthetic-space", sql: { db: () => sql } };
      globalThis.fetch = async url => {
        if (String(url).endsWith("/api/chat/model-selection")) return Response.json({ model: "z-ai/glm-5.3", reason: "healthy" });
        requests++; throw Error("Unexpected chat request after Stop");
      };
      const sessionStore = { getToken: () => "synthetic-token" };
      const selection = new ModelSelectionCoordinator({ tcw, backendUrl: "https://synthetic.invalid", sessionStore, onView() {} });
      selection.activate("t", "new");
      for (let i = 0; i < 100 && !selection.getView().canSend; i++) await Bun.sleep(2);
      const outcomes = createTurnOutcomeStore();
      const history = createHistoryAdapter(tcw, "t", selection, () => { extraction++; }, undefined, outcomes);
      const adapter = createChatModelAdapter({ sessionStore, backendUrl: "https://synthetic.invalid", selection, agentEnabledRef: { current: false }, turnOutcomes: outcomes });
      const delayed = { async *run(input) { if (beforeAdapter) await adapterReady.promise; yield* adapter.run(input); } };
      let assistantAppend;
      const runtime = new LocalThreadRuntimeCore({ getModelContext: () => ({}) }, { adapters: { chatModel: delayed, history: { load: async () => ({ messages: [] }), append: item => { const pending = history.append(item); if (item.message.role === "assistant") assistantAppend = pending; return pending; } } } });
      runtime.composer.setText("Synthetic Stop before request");
      await runtime.composer.send();
      await writeStarted.promise;
      runtime.cancelRun();
      adapterReady.resolve();
      await Bun.sleep(20);
      writeReady.resolve();
      for (let i = 0; i < 100 && !assistantAppend; i++) await Bun.sleep(2);
      await assistantAppend;
      await Bun.sleep(20);
      const doc = await getThread(tcw, "t");
      const terminal = doc?.messages.find(item => item.message.role === "assistant");
      const message = runtime.messages.at(-1);
      if (terminal) {
        await history.append({ parentId: message.id, message: { ...message, content: [{ type: "text", text: "LATE_OVERWRITE" }] } });
      }
      const reloaded = await getThread(tcw, "t");
      results.push({ beforeAdapter, requests, extraction, users: reloaded?.messages.filter(item => item.message.role === "user").length, assistants: reloaded?.messages.filter(item => item.message.role === "assistant").length, terminal: terminal?.turn, content: terminal?.message.content, lateOverwrite: JSON.stringify(reloaded).includes("LATE_OVERWRITE"), uiStatus: message.status });
      selection.dispose();
      db.close();
    }
    console.log(JSON.stringify(results));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const results = JSON.parse(stdout);
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.requests).toBe(0);
    expect(result.users).toBe(1);
    expect(result.assistants).toBe(1);
    expect(result.terminal).toMatchObject({ status: "cancelled", private: true });
    expect(result.content).toEqual([{ type: "text", text: "Request cancelled." }]);
    expect(result.lateOverwrite).toBe(false);
    expect(result.extraction).toBe(0);
    expect(result.uiStatus).toEqual({ type: "incomplete", reason: "cancelled" });
  }
}, 5000);
