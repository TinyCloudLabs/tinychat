// The web recorder engine as the app boots it, in real Chromium (fake microphone): record, kill the tab,
// start again and find the recording as a pending note with the web engine's capabilities.
// Heavy (a browser, real timers): run it when the machine's load is low.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import type { WebEngineApi } from "./recorder-final-web-engine.page";

setDefaultTimeout(60_000);

declare global { interface Window { engine: WebEngineApi } }

const call = <K extends keyof WebEngineApi>(page: Page, name: K, ...args: Parameters<WebEngineApi[K]>) =>
  page.evaluate(([n, a]) => (window.engine[n as keyof WebEngineApi] as (...x: unknown[]) => unknown)(...(a as unknown[])), [name, args] as const) as Promise<Awaited<ReturnType<WebEngineApi[K]>>>;

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let chrome: Browser;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./recorder-final-web-engine.page.ts", import.meta.url).pathname],
    target: "browser",
    define: { "import.meta.env": "{}" },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const bundle = await built.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      return new Response('<!doctype html><title>web engine</title><script type="module" src="/bundle.js"></script>', { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}/`;
  chrome = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
}, 120_000);

afterAll(async () => {
  await Promise.race([chrome?.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server?.stop(true);
});

describe("web engine boot recovery in Chromium", () => {
  test("record → kill the tab → reload: the interrupted recording is a pending, recovered row", async () => {
    const context = await chrome.newContext({ permissions: ["microphone"] });
    const dbName = `web-engine-${crypto.randomUUID()}`;
    const open = async () => {
      const page = await context.newPage();
      page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
      await page.goto(origin);
      await page.waitForFunction(() => "engine" in window);
      return page;
    };

    const first = await open();
    const { id, audioMs } = await call(first, "recordUntil", dbName, 2000);
    expect(audioMs).toBeGreaterThanOrEqual(2000);
    await first.close({ runBeforeUnload: false });

    const second = await open();
    // The dead tab's recording lock can take a moment to be released.
    let booted = await call(second, "boot", dbName);
    for (let attempt = 0; attempt < 20 && booted.pending.length === 0 && booted.recoveryFailed.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      booted = await call(second, "boot", dbName);
    }
    expect(booted.recoveryFailed, JSON.stringify(booted.recoveryFailed)).toEqual([]);
    expect(booted.pending).toHaveLength(1);
    expect(booted.pending[0]).toMatchObject({ id, mimeType: "audio/webm;codecs=opus", recovered: true });
    expect(booted.pending[0]!.sizeBytes).toBeGreaterThan(0);
    expect(booted.capabilities).toEqual({
      nativeShortcuts: false, presentRecorder: false, openSettings: false, micDeniedPresentation: false,
      background: false, localTranscription: false, offlineRecorder: false,
    });
    await context.close();
  });
});
