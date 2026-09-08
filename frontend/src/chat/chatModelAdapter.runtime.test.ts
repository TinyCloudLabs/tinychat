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
    import { createMeetingMessageRegistry, takePendingReceipt, takePendingCompletion } from "./frontend/src/chat/pendingHandoff.ts";
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
          agentEnabledRef: { current: true }, meetingMessageRegistry: createMeetingMessageRegistry(),
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
