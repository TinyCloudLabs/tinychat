// The web voice-notes engine against real browser codecs (TC-879). The unit tests fake MediaRecorder and
// the decoder; this records through the real ones and decodes what the store holds.
//
//   Chromium: fake microphone (--use-fake-device-for-media-stream), WebM/Opus. Always runs.
//   WebKit:   MP4/AAC. Playwright's WebKit has no fake microphone; the test logs why and returns
//             when this build cannot record, and runs for real wherever it can.
//
// Heavy (two browsers, real timers): run it when the machine's load is low.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import type { CodecApi } from "./web-voice-notes-codec.page";

setDefaultTimeout(60_000);

type Codec = CodecApi;
declare global { interface Window { codec: Codec } }

const call = <K extends keyof Codec>(page: Page, name: K, ...args: Parameters<Codec[K]>) =>
  page.evaluate(([n, a]) => (window.codec[n as keyof Codec] as (...x: unknown[]) => unknown)(...(a as unknown[])), [name, args] as const) as Promise<Awaited<ReturnType<Codec[K]>>>;

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let chrome: Browser;
let safari: Browser | null = null;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [new URL("./web-voice-notes-codec.page.ts", import.meta.url).pathname],
    target: "browser",
    define: { "import.meta.env": "{}" },
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const bundle = await built.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      return new Response('<!doctype html><title>codec</title><script type="module" src="/bundle.js"></script>', {
        headers: { "content-type": "text/html" },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}/`;
  chrome = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  safari = await webkit.launch({ headless: true }).catch((error: unknown) => {
    console.log(`SKIP webkit: it cannot be launched here (${error instanceof Error ? error.message : String(error)})`);
    return null;
  });
}, 120_000);

afterAll(async () => {
  const closing = Promise.all([chrome?.close(), safari?.close()]);
  await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  server?.stop(true);
});

// A context is a browser profile: pages opened in the same one share IndexedDB, as tabs of one browser do.
async function openPage(
  browser: Browser, name: "chromium" | "webkit", existing?: BrowserContext,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = existing ?? await browser.newContext(name === "chromium" ? { permissions: ["microphone"] } : {});
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`[${name} pageerror] ${error.message}`));
  await page.goto(origin);
  await page.waitForFunction(() => "codec" in window);
  return { context, page };
}

const dbName = (label: string) => `codec-${label}-${crypto.randomUUID()}`;

describe("chromium: WebM/Opus", () => {
  test("record, pause, resume and stop: the mic is released while paused and the stored bytes are one decodable WebM", async () => {
    const { context, page } = await openPage(chrome, "chromium");
    const probe = await call(page, "probe");
    expect(probe).toMatchObject({ mediaRecorder: true, webm: true, getUserMedia: "ok" });
    const run = await call(page, "recordPauseResume", dbName("webm"), 1500, 600);
    expect(run.pausedState).toBe("paused");
    expect(run.liveWhilePaused).toBe(0);
    expect(run.liveAfterStop).toBe(0);
    expect(run.note.mimeType).toBe("audio/webm;codecs=opus");
    expect(run.note.pausedMs).toBeGreaterThanOrEqual(500);
    expect(run.storedBytes).toBe(run.note.sizeBytes);
    expect(run.ebmlHeaders).toBe(1);
    expect(run.decoded.ok, JSON.stringify(run.decoded)).toBe(true);
    if (!run.decoded.ok) return;
    expect(run.decoded.durationMs).toBeGreaterThan(2000);
    expect(run.decoded.durationMs).toBeLessThan(5000);
    expect(Math.abs(run.decoded.durationMs - run.note.durationMs)).toBeLessThan(1500);
    await context.close();
  });

  test("a tab killed before stop leaves a prefix that recovery accepts and the browser decodes", async () => {
    const db = dbName("prefix");
    const first = await openPage(chrome, "chromium");
    const { audioMs } = await call(first.page, "recordUntil", db, 2000);
    expect(audioMs).toBeGreaterThanOrEqual(2000);
    await first.page.close({ runBeforeUnload: false });

    const second = await openPage(chrome, "chromium", first.context);
    let result = await call(second.page, "recover", db);
    for (let attempt = 0; attempt < 20 && result.recovered.length + result.failed.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await call(second.page, "recover", db);
    }
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(result.recovered).toHaveLength(1);
    const [note] = result.recovered;
    expect(note!.mimeType).toBe("audio/webm;codecs=opus");
    expect(note!.ebmlHeaders).toBe(1);
    expect(note!.decoded.ok, JSON.stringify(note!.decoded)).toBe(true);
    if (note!.decoded.ok) expect(note!.decoded.durationMs).toBeGreaterThan(1000);
    await second.context.close();
  });

  test("a 60 s+ recording is recovered by decoding only the first 10 s window; its duration comes from the journal", async () => {
    const db = dbName("long");
    const first = await openPage(chrome, "chromium");
    const seeded = await call(first.page, "seedLong", db, 65_000, 3300);
    expect(seeded.journaledMs).toBeGreaterThanOrEqual(60_000);
    expect(seeded.windowBytes).toBeGreaterThan(0);
    expect(seeded.totalBytes).toBeGreaterThan(seeded.windowBytes * 4);
    await first.page.close({ runBeforeUnload: false });

    const second = await openPage(chrome, "chromium", first.context);
    const result = await call(second.page, "recoverLong", db);
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(result.quarantine).toEqual([]);
    expect(result.recovered).toMatchObject([{ id: seeded.id, sizeBytes: seeded.totalBytes, durationMs: seeded.journaledMs }]);
    expect(result.decodedBytes).toEqual([seeded.windowBytes]);
    await second.context.close();
  });

  test("bytes that are not media are quarantined as undecodable, with the audio kept", async () => {
    const db = dbName("garbage");
    const first = await openPage(chrome, "chromium");
    const { id } = await call(first.page, "seedGarbage", db, "audio/webm;codecs=opus");
    await first.page.close({ runBeforeUnload: false });

    const second = await openPage(chrome, "chromium", first.context);
    let result = await call(second.page, "recover", db);
    for (let attempt = 0; attempt < 20 && result.recovered.length + result.failed.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await call(second.page, "recover", db);
    }
    expect(result.recovered).toEqual([]);
    expect(result.failed).toMatchObject([{ id, reason: "undecodable_audio" }]);
    expect(result.quarantine).toEqual([{ id, reason: "undecodable_audio", sizeBytes: 4096 }]);
    await second.context.close();
  });
});

describe("webkit: MP4/AAC", () => {
  test("record, pause, resume and stop: the stored bytes are one decodable MP4", async () => {
    if (!safari) {
      console.log("SKIP webkit MP4/AAC: WebKit could not be launched.");
      return;
    }
    const { context, page } = await openPage(safari, "webkit");
    const probe = await call(page, "probe");
    if (!probe.mediaRecorder || !probe.mp4 || probe.getUserMedia !== "ok") {
      console.log(`SKIP webkit MP4/AAC: this WebKit cannot record here (${JSON.stringify(probe)}).`);
      await context.close();
      return;
    }
    const run = await call(page, "recordPauseResume", dbName("mp4"), 1500, 600);
    expect(run.liveWhilePaused).toBe(0);
    expect(run.note.mimeType).toBe("audio/mp4");
    expect(run.ftypBoxes).toBe(1);
    expect(run.decoded.ok, JSON.stringify(run.decoded)).toBe(true);
    await context.close();
  });
});
