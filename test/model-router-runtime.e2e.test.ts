import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { OFFERED_CHAT_MODELS } from "../packages/core/src/chatModels";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let bundle = "";
let selectionReleases: Array<() => void> = [];
let requests: string[] = [];
let chatBodies: Array<{ model: string; messages: Array<{ content: string }> }> = [];

beforeAll(async () => {
  const frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url));
  const { build } = await import(new URL('./dist/node/index.js', pathToFileURL(frontendRequire.resolve('vite/package.json'))).href);
  const built = await build({
    configFile: false, logLevel: 'error',
    root: new URL('../frontend', import.meta.url).pathname,
    define: { 'import.meta.env': '{}' },
    resolve: { alias: { '@': new URL('../frontend/src', import.meta.url).pathname } },
    build: { write: false, minify: false, rollupOptions: {
      input: new URL('../frontend/src/chat/modelRouterRuntimeHarness.tsx', import.meta.url).pathname,
      output: { inlineDynamicImports: true },
    } },
  });
  bundle = (Array.isArray(built) ? built[0] : built).output.find((item: any) => item.type === 'chunk').code;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") {
        return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname === "/api/chat/model-selection") {
        requests.push("selection");
        const scenario = url.searchParams.get("scenario") ?? request.headers.get("referer") ?? "";
        if (scenario.includes("wait") || scenario.includes("cancel-lookup")) {
          await new Promise<void>((resolve) => { selectionReleases.push(resolve); });
        }
        if (scenario.includes("unhealthy")) {
          return Response.json({ model: null, reason: "all-unhealthy" });
        }
        return Response.json({ model: OFFERED_CHAT_MODELS[0].id, reason: "healthy" });
      }
      if (url.pathname === "/api/chat" || url.pathname === "/api/agent/chat") {
        const body = await request.json() as { model: string; messages: Array<{ content: string }> };
        chatBodies.push(body);
        requests.push(`chat:${body.model}`);
        if (body.messages.at(-1)?.content.startsWith('LEAN_PRIVATE') || body.messages.at(-1)?.content === 'Continue') {
          const wire = body as any;
          const sources = ['C', 'A', 'B'].map(id => ({ source: 'fireflies', sourceId: id, meetingRef: id, revision: `r-${id}` }));
          const continued = !!wire.turn.continuation;
          const result = { version: 3, private: true, turnId: wire.turn.turnId, status: continued ? 'completed' : 'partial', text: continued ? 'Scan continued.' : 'Synthetic private answer.', sources, citations: [], obligations: [], limitations: [], coverage: [], receipts: { modelCalls: 1, ioAttempts: 3, recovery: 'none', elapsedMs: 2 },
            ...(!continued ? { continuation: { version: 3, cursor: 'C', pending: [{ source: 'fireflies', sourceId: 'D', meetingRef: 'D', revision: 'd'.repeat(64) }], encountered: sources, examinedSources: 3, matchedSources: 3, exhausted: true, intent: { mode: 'search', parts: [{ id: 'p', question: 'literal' }], terms: ['literal'] } } } : {}) };
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: result.text } }] })}\n\ndata: ${JSON.stringify({ meeting_result: result })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(
          'data: {"id":"completion-1","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response('<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', {
        headers: { "content-type": "text/html" },
      });
    },
  });
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function pageFor(scenario: string): Promise<Page> {
  requests = [];
  chatBodies = [];
  selectionReleases = [];
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?scenario=${scenario}`);
  await page.waitForFunction(() => Boolean(window.routerHarness));
  return page;
}

async function events(page: Page): Promise<string[]> {
  return page.evaluate(() => [...window.routerHarness!.events]);
}

describe.serial("mounted real useChatRuntime lifecycle", () => {
  test('private Send persists status and ordered refs through browser reload and Continue', async () => {
    const page = await pageFor('lean-private');
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    await page.evaluate(() => window.routerHarness!.send('LEAN_PRIVATE search'));
    await page.waitForFunction(() => window.routerHarness!.events.includes('assistant-stored'));
    await page.locator('[data-meeting-status="partial"]').waitFor();
    const threadId = await page.evaluate(() => window.routerHarness!.view().threadId!);
    const saved = await page.evaluate(() => window.routerHarness!.messages().flatMap(([, payloads]) => payloads.map(JSON.parse)));
    expect(saved.at(-1).turn.result.sources.map((source: any) => source.sourceId)).toEqual(['C', 'A', 'B']);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.routerHarness));
    await page.evaluate(id => window.routerHarness!.switchTo(id), threadId);
    await page.locator('[data-meeting-status="partial"]').waitFor();
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 1000 });
    await page.locator('[data-meeting-status="completed"]').waitFor();
    const continuationRequest = chatBodies.at(-1) as any;
    expect(continuationRequest.turn.parent.sources.map((source: any) => source.sourceId)).toEqual(['C', 'A', 'B']);
    expect(continuationRequest.turn.continuation.cursor).toBe('C');
    expect(JSON.stringify(continuationRequest.messages)).not.toContain('Synthetic private answer');
    expect(continuationRequest.publicTools).toBe(false);
    await page.close();
  });

  test("first send waits for automatic selection before append and inference", async () => {
    const page = await pageFor("first-wait");
    await page.evaluate(() => window.routerHarness!.send());
    await page.waitForTimeout(75);
    expect((await events(page)).some((event) => event.startsWith("append:"))).toBe(false);
    expect(requests.some((entry) => entry.startsWith("chat:"))).toBe(false);
    selectionReleases.splice(0).forEach((release) => release());
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.startsWith("append:")));
    await page.waitForFunction(() => document.querySelector("#sendable")?.textContent === "true");
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[0].id}`);
    await page.close();
  });

  test("immediate send after reopen waits for restoration and uses the saved model", async () => {
    const page = await pageFor("reopen-restore-delay");
    await page.evaluate(async () => {
      await window.routerHarness!.switchExisting();
      window.routerHarness!.send("reopened");
    });
    await page.waitForTimeout(75);
    expect(requests.some((entry) => entry.startsWith("chat:"))).toBe(false);
    await page.evaluate(() => window.routerHarness!.releaseRestore());
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.includes("append:saved-thread")));
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[2].id}`);
    await page.close();
  });

  test("all-unhealthy blocks side effects until a manual fourth-model choice resolves the same wait", async () => {
    const page = await pageFor("unhealthy");
    await page.waitForFunction(() => document.querySelector("#phase")?.textContent === "needs-manual-choice");
    await page.evaluate(() => window.routerHarness!.send());
    await page.waitForTimeout(75);
    expect((await events(page)).some((event) => event.startsWith("append:"))).toBe(false);
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[3].id);
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.startsWith("append:")));
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[3].id}`);
    await page.close();
  });

  test("restoration read failure is recoverable by retry without recreating the row", async () => {
    const page = await pageFor("reopen-restore-fail");
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.waitForFunction(() => document.querySelector("#message")?.textContent?.startsWith("Retry loading"));
    await page.evaluate(() => window.routerHarness!.retry());
    await page.waitForFunction(() => document.querySelector("#sendable")?.textContent === "true");
    await page.evaluate(() => window.routerHarness!.send("after retry"));
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.includes("append:saved-thread")));
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[2].id}`);
    await page.close();
  });

  test("navigation cancels queued lookup work and late results cannot resume that turn", async () => {
    const page = await pageFor("cancel-lookup-wait");
    const originalId = await page.evaluate(() => window.routerHarness!.view().threadId!);
    await page.evaluate(() => window.routerHarness!.send("cancel me"));
    await page.waitForTimeout(25);
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.waitForFunction(() => window.routerHarness!.view().threadId === "saved-thread");
    selectionReleases.splice(0).forEach((release) => release());
    await page.waitForTimeout(150);
    expect((await events(page)).some((event) => event.startsWith("append:"))).toBe(false);
    expect(requests.some((entry) => entry.startsWith("chat:"))).toBe(false);
    expect(await page.evaluate(() => window.routerHarness!.view().phase)).not.toBe("choosing");
    await page.evaluate((id) => window.routerHarness!.switchTo(id), originalId);
    await page.waitForFunction(() => window.routerHarness!.view().phase === "needs-manual-choice");
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[1].id);
    await page.waitForTimeout(75);
    expect(requests.filter((entry) => entry.startsWith("chat:"))).toEqual([]);
    await page.evaluate(() => window.routerHarness!.send("fresh submission"));
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.startsWith("append:")));
    expect(requests.filter((entry) => entry === "selection")).toHaveLength(1);
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[1].id}`);
    await page.close();
  });

  test("navigation during restoration cancels the old turn with no append or request", async () => {
    const page = await pageFor("reopen-restore-delay");
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.waitForFunction(() => window.routerHarness!.view().threadId === "saved-thread");
    await page.evaluate(() => window.routerHarness!.send("cancel restore"));
    await page.waitForTimeout(25);
    await page.evaluate(() => window.routerHarness!.switchNew());
    await page.waitForFunction(() => window.routerHarness!.view().threadId !== "saved-thread");
    await page.evaluate(() => window.routerHarness!.releaseRestore());
    await page.waitForTimeout(150);
    expect((await events(page)).some((event) => event.startsWith("append:"))).toBe(false);
    expect(requests.filter((entry) => entry.startsWith("chat:"))).toEqual([]);
    await page.close();
  });
  test("a pick during first insertion stays saving and preserves the original turn model", async () => {
    const page = await pageFor("insert-delay-save-delay");
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    await page.evaluate(() => window.routerHarness!.send());
    await page.waitForFunction(() => window.routerHarness!.events.includes("insert-entered"));
    expect(await page.evaluate(() => window.routerHarness!.view().canPick)).toBe(true);
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[1].id);
    expect(requests.filter((entry) => entry.startsWith("chat:"))).toEqual([]);
    await page.evaluate(() => window.routerHarness!.releaseInsert());
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.startsWith("append:")));
    expect(await page.evaluate(() => window.routerHarness!.view().canSend)).toBe(false);
    await page.evaluate(() => window.routerHarness!.releaseSave());
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    expect(await page.evaluate(() => window.routerHarness!.rows()[0][1].model)).toBe(OFFERED_CHAT_MODELS[1].id);
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[0].id}`);
    await page.close();
  });

  test("failed first insertion blocks inference and the visible Retry recovers it", async () => {
    const page = await pageFor("insert-fail");
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    await page.evaluate(() => window.routerHarness!.send());
    await page.waitForFunction(() => window.routerHarness!.view().saveFailed);
    expect(requests.filter((entry) => entry.startsWith("chat:"))).toEqual([]);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    expect(await page.evaluate(() => window.routerHarness!.rows().length)).toBe(1);
    await page.close();
  });

  test("failed model save keeps sends blocked until the latest manual choice is saved", async () => {
    const page = await pageFor("reopen-save-fail");
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[1].id);
    await page.waitForFunction(() => window.routerHarness!.view().saveFailed);
    expect(await page.getByRole("textbox").isDisabled()).toBe(true);
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[0].id);
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    expect(await page.evaluate(() => window.routerHarness!.rows()[0][1].model)).toBe(OFFERED_CHAT_MODELS[0].id);
    await page.close();
  });

  test("manual override supersedes a delayed restore; removed DeepSeek 0731 corrects SQL to Kimi before send", async () => {
    const page = await pageFor("reopen-retired-restore-delay");
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[1].id);
    await page.evaluate(() => window.routerHarness!.releaseRestore());
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    expect(await page.evaluate(() => window.routerHarness!.view().model)).toBe(OFFERED_CHAT_MODELS[1].id);
    expect(await page.evaluate(() => window.routerHarness!.rows()[0][1].model)).toBe(OFFERED_CHAT_MODELS[1].id);
    await page.close();
    const corrected = await pageFor("reopen-retired");
    await corrected.evaluate(() => window.routerHarness!.switchExisting());
    await corrected.waitForFunction(() => window.routerHarness!.view().threadId === "saved-thread" && window.routerHarness!.view().canSend);
    expect(await corrected.evaluate(() => window.routerHarness!.rows()[0][1].model)).toBe("moonshotai/kimi-k3");
    await corrected.close();
  });

  test("missing rows show Chat unavailable and cannot be recreated by send or pick", async () => {
    const page = await pageFor("reopen-missing");
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.waitForFunction(() => window.routerHarness!.view().message === "Chat unavailable.");
    expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(1);
    await page.evaluate((model) => { window.routerHarness!.pick(model); window.routerHarness!.send(); }, OFFERED_CHAT_MODELS[1].id);
    await page.waitForTimeout(75);
    expect((await events(page)).filter((event) => event.startsWith("append:"))).toEqual([]);
    expect(requests.filter((entry) => entry.startsWith("chat:"))).toEqual([]);
    await page.close();
  });

  test("cancel while choosing does not resume the queued turn after a manual pick", async () => {
    const page = await pageFor("first-wait");
    await page.evaluate(() => window.routerHarness!.send());
    await page.waitForTimeout(50);
    await page.evaluate(() => window.routerHarness!.cancel());
    selectionReleases.splice(0).forEach((release) => release());
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[1].id);
    await page.waitForTimeout(75);
    expect((await events(page)).filter((event) => event.startsWith("append:"))).toEqual([]);
    expect(requests.filter((entry) => entry.startsWith("chat:"))).toEqual([]);
    await page.close();
  });

  test("Strict Mode replays share one lookup and do not cancel the first choice", async () => {
    const page = await pageFor("strict-first-wait");
    await page.evaluate(() => window.routerHarness!.send());
    await page.waitForTimeout(75);
    selectionReleases.splice(0).forEach((release) => release());
    await page.waitForFunction(() => window.routerHarness!.events.some((event) => event.startsWith("append:")));
    expect(requests.filter((entry) => entry === "selection")).toHaveLength(1);
    expect(requests).toContain(`chat:${OFFERED_CHAT_MODELS[0].id}`);
    await page.close();
  });

  test("delayed extraction keeps the completed turn model and exchange after navigation and a pick", async () => {
    const page = await pageFor("extraction-delay-reopen");
    await page.waitForFunction(() => window.routerHarness!.view().canSend);
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[1].id);
    await page.evaluate(() => window.routerHarness!.send("ORIGIN_EXCHANGE"));
    await page.waitForFunction(() => window.routerHarness!.events.includes("extraction-waiting"));
    await page.evaluate(() => window.routerHarness!.switchExisting());
    await page.waitForFunction(() => window.routerHarness!.view().threadId === "saved-thread" && window.routerHarness!.view().canSend);
    await page.evaluate((model) => window.routerHarness!.pick(model), OFFERED_CHAT_MODELS[0].id);
    await page.evaluate(() => window.routerHarness!.releaseExtraction());
    await page.waitForTimeout(100);
    const extraction = chatBodies.find((body) => body.messages[0]?.content.includes("user_context"));
    expect(extraction?.model).toBe(OFFERED_CHAT_MODELS[1].id);
    expect(extraction?.messages[1]?.content).toContain("ORIGIN_EXCHANGE");
    expect(await page.evaluate(() => window.routerHarness!.view().model)).toBe(OFFERED_CHAT_MODELS[0].id);
    await page.close();
  });

});
