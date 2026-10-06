// Runtime invariants of the shell (TC-761, plan §8.3), on the real AppShell
// and surfaces (frontend/src/harness/shellIntegrationHarness.tsx), under
// StrictMode:
//
//   1. Nothing the user is in the middle of is lost: a draft and a streaming
//      reply survive every tab, Settings, rotation and size class, and the chat
//      and Capture surfaces never remount.
//   2. One recorder: the native plugin never has more than one view listening
//      (the Capture card, or the chat bar), and none on Connectors.
//   3. Android Back closes overlays first, the top one first, then goes home.
//   4. Retired addresses end on the Library.
//   5. How it works opens at the section a link names, with its heading
//      focused; a malformed or unknown anchor opens it at the top.
//   6. An InfoTip opens on a tap and closes on a second tap, an outside tap
//      or Escape.
//   7. Discard asks in place, with focus on Keep, and turns back after 5 s;
//      confirmed, it stops and deletes the recording and closes the recorder.
//
// SHELL_ENGINE=webkit runs it in WebKit (the phone app's engine); Chromium by default (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { OFFERED_CHAT_MODELS } from "../packages/core/src/chatModels";

const frontend = new URL("../frontend/", import.meta.url).pathname;

let bundle = "";
let css = "";
/** Held chat streams: each call finishes its reply. */
let releases: Array<() => void> = [];
let chatRequests = 0;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${frontend}src/harness/shellIntegrationHarness.tsx`],
    root: frontend,
    target: "browser",
    minify: false,
    define: { "import.meta.env": "{}" },
    external: ["/fonts/*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = await built.outputs.find((output) => output.kind === "entry-point")!.text();

  const requireFromFrontend = createRequire(`${frontend}package.json`);
  const postcss = requireFromFrontend("postcss");
  const tailwindcss = requireFromFrontend("tailwindcss");
  const source = await Bun.file(`${frontend}src/index.css`).text();
  const config = (await import(`${frontend}tailwind.config.js`)).default;
  config.content = [`${frontend}index.html`, `${frontend}src/**/*.{js,ts,jsx,tsx}`];
  css = (await postcss([tailwindcss(config)]).process(source, { from: `${frontend}src/index.css` })).css;
}, 120_000);

const encoder = new TextEncoder();
const chunk = (content: string) => encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content } }] })}\n\n`);

function startServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/app.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/api/chat/model-selection") {
        return Response.json({ model: OFFERED_CHAT_MODELS[0].id, reason: "healthy" });
      }
      if (url.pathname === "/api/chat" && request.method === "POST") {
        chatRequests += 1;
        // The reply starts at once and finishes only when the test releases it.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk("Hello"));
            releases.push(() => {
              controller.enqueue(chunk(" there"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            });
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      return new Response(
        '<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}

const engines: Record<string, BrowserType> = { webkit, chromium };
const name = process.env.SHELL_ENGINE ?? "chromium";
const engine = engines[name];
if (!engine) throw new Error(`SHELL_ENGINE must be one of ${Object.keys(engines).join(", ")}`);

const settle = (page: Page) => page.waitForTimeout(250);
const mounts = (page: Page) => page.evaluate(() => ({ ...window.__mounts }));
const activeListeners = (page: Page) => page.evaluate(() => window.shellHarness!.voiceNotes().active);

async function go(page: Page, path: string) {
  await page.evaluate((to) => window.shellHarness!.navigate(to), path);
  await page.waitForFunction((to) => window.location.pathname === to, path);
  await settle(page);
}

describe.serial(`shell invariants (${name})`, () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    server = startServer();
    browser = await engine.launch({ headless: true });
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  }, 30_000);

  async function open(path: string, viewport = { width: 390, height: 844 }) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}${path}`);
    await page.waitForFunction(() => window.shellHarness !== undefined);
    return { page, errors };
  }

  test("a draft and a streaming reply survive tabs, Settings, rotation and every size class; nothing remounts", async () => {
    releases = [];
    chatRequests = 0;
    const { page, errors } = await open("/chat");
    const composer = page.locator('textarea[placeholder^="Message"]');
    await page.waitForFunction(() => {
      const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Message"]');
      return field !== null && !field.disabled;
    });

    // Start a reply and leave it streaming; then write a draft.
    await composer.fill("What did we decide on Friday?");
    await composer.press("Enter");
    await page.getByText("Hello", { exact: true }).waitFor();
    expect(chatRequests).toBe(1);
    await composer.fill("my draft");

    await go(page, "/chat/capture");
    await go(page, "/chat/connectors");
    await go(page, "/chat");
    await go(page, "/chat/settings");
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
    // Settings' Back (and Android Back) returns through history.
    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => window.location.pathname === "/chat");

    for (const [width, height] of [[844, 390], [1023, 768], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await settle(page);
    }

    releases.splice(0).forEach((release) => release());
    await page.getByText("Hello there", { exact: true }).waitFor();

    expect(await composer.inputValue()).toBe("my draft");
    const counted = await mounts(page);
    expect(counted.chat).toBe(1);
    expect(counted.capture).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("one recorder: the provider's three listeners from ready on; navigation, Settings and resizes add none", async () => {
    const { page, errors } = await open("/chat/capture");
    const stats = () => page.evaluate(() => window.shellHarness!.voiceNotes());
    let highest = 0;
    const sample = async () => {
      for (let i = 0; i < 5; i++) {
        highest = Math.max(highest, await activeListeners(page));
        await page.waitForTimeout(30);
      }
    };

    await page.getByTestId("voice-note-record").waitFor();
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().active === 3);
    const addsAtReady = (await stats()).adds;

    for (const path of ["/chat", "/chat/connectors", "/chat/settings", "/chat/capture", "/chat"]) {
      await go(page, path);
      await sample();
    }
    for (const [width, height] of [[844, 390], [820, 1180], [1280, 800], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await settle(page);
      await sample();
    }
    expect((await stats()).adds).toBe(addsAtReady);

    // Record from the chat header: the recorder opens and records.
    await page.getByTestId("header-voice-note").click();
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().recording);
    await page.getByTestId("voice-note-stop").waitFor();
    // Back (Escape) minimises it without stopping; the island follows to Connectors.
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="voice-note-stop"]')?.disabled);
    await page.evaluate(() => window.shellHarness!.back());
    await page.getByTestId("recorder-island").waitFor();
    expect((await stats()).recording).toBe(true);
    await go(page, "/chat/connectors");
    await page.getByTestId("recorder-island").waitFor();
    // On its side the rail carries it, and no island floats over Send.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByTestId("rail-live").waitFor();
    expect(await page.getByTestId("recorder-island").count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    // Stop from the island: the save runs and the island turns into its receipt.
    await page.getByTestId("island-stop").click();
    await page.waitForFunction(() => !window.shellHarness!.voiceNotes().recording);
    await page.waitForFunction(() => /landed|failed/.test(document.querySelector('[data-testid="recorder-island"]')?.getAttribute("data-state") ?? ""));
    await sample();

    expect((await stats()).adds).toBe(addsAtReady);
    expect(highest).toBe(3);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("discard: the question takes focus to Keep and turns back after 5 s; confirmed, the recording is deleted and the recorder closes", async () => {
    const { page, errors } = await open("/chat/capture");
    const stats = () => page.evaluate(() => window.shellHarness!.voiceNotes());
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

    await page.getByTestId("voice-note-record").click();
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().recording);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid="voice-note-stop"]')?.disabled);

    // Asked in place: focus moves to Keep; 5 s without an answer turns it back, focus with it.
    await page.getByTestId("recorder-discard").click();
    await page.getByTestId("recorder-discard-confirm").waitFor();
    expect(await page.getByRole("group", { name: "Discard this recording?" }).count()).toBe(1);
    expect(await focused()).toBe("recorder-discard-keep");
    await page.waitForTimeout(4_000);
    expect(await page.getByTestId("recorder-discard-confirm").count()).toBe(1);
    await page.getByTestId("recorder-discard").waitFor({ timeout: 3_000 });
    expect(await page.getByTestId("recorder-discard-confirm").count()).toBe(0);
    expect(await focused()).toBe("recorder-discard");

    // Keep: nothing happens to the recording.
    await page.getByTestId("recorder-discard").click();
    await page.getByTestId("recorder-discard-keep").click();
    await page.getByTestId("recorder-discard").waitFor();
    expect(await focused()).toBe("recorder-discard");
    expect((await stats()).recording).toBe(true);

    // Discard: stopped, deleted from the phone, nothing saved, and the recorder closes.
    await page.getByTestId("recorder-discard").click();
    await page.getByTestId("recorder-discard-yes").click();
    await page.waitForFunction(() => !window.shellHarness!.voiceNotes().recording);
    await page.waitForFunction(() => document.querySelector('[data-testid="recorder-announcer"]')?.textContent === "Recording discarded");
    await page.waitForFunction(() => document.querySelector('[data-testid="recorder-sheet"]') === null);
    expect((await stats()).deleted).toEqual(["fake-1"]);
    expect(await page.getByTestId("recorder-island").count()).toBe(0);
    expect(await page.getByTestId("voice-note-record").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("offline → ready: the offline recorder's listeners go before the provider's arrive; never above three", async () => {
    const { page, errors } = await open("/chat");
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().active === 3);
    const watch = page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let max = 0;
          const timer = setInterval(() => {
            max = Math.max(max, window.shellHarness!.voiceNotes().active);
          }, 5);
          setTimeout(() => {
            clearInterval(timer);
            resolve(max);
          }, 1500);
        }),
    );
    await page.evaluate(() => window.shellHarness!.setState("offline"));
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().active === 2);
    await page.evaluate(() => window.shellHarness!.setState("ready"));
    await page.waitForFunction(() => window.shellHarness!.voiceNotes().active === 3);
    expect(await watch).toBeLessThanOrEqual(3);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("Android Back closes the top overlay first, then the next, then goes home", async () => {
    const { page, errors } = await open("/chat");
    const openDialogs = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"][data-state="open"]')].map(
          (dialog) => dialog.querySelector("h2")?.textContent ?? "",
        ),
      );

    // The model sheet (vaul), then the Chats sheet (Radix) over it.
    const chip = page.getByRole("button", { name: "Model" });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')?.disabled);
    await chip.click();
    await page.locator('[data-testid="model-sheet"][data-state="open"]').waitFor();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Chats"]')!.click());
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 2);
    expect(await openDialogs()).toEqual(["Model", "Chats"]);

    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 1);
    expect(await openDialogs()).toEqual(["Model"]);
    // The next press comes once the closed sheet has finished leaving: until
    // its exit animation ends it is still the top layer, and a press then is
    // simply dropped.
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);

    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 0);

    // No overlay left: Chat is not the Android app's home, so Back goes to Capture…
    await page.evaluate(() => window.shellHarness!.back());
    await page.waitForFunction(() => window.location.pathname === "/chat/capture");
    // …and at home it minimises, never exits.
    await settle(page);
    await page.evaluate(() => window.shellHarness!.back());
    expect(await page.evaluate(() => window.shellHarness!.minimized())).toBe(1);
    expect(await page.evaluate(() => window.location.pathname)).toBe("/chat/capture");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("How it works opens at the anchor's section with its heading focused; a bad anchor opens at the top", async () => {
    const at = async (path: string) => {
      const { page, errors } = await open(path);
      await page.locator("[data-about-section]").first().waitFor();
      await settle(page);
      return { page, errors };
    };

    const { page, errors } = await at("/chat/about#connectors");
    await page.waitForFunction(() => document.activeElement?.id === "about-connectors-heading");
    const placed = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-surface="about"] [data-scroll-root]')!;
      const section = document.getElementById("connectors")!;
      return {
        scrolled: scroller.scrollTop,
        offset: section.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      };
    });
    expect(placed.scrolled).toBeGreaterThan(0);
    // Its top sits just under the sticky header (scroll-margin), not mid-page.
    expect(placed.offset).toBeGreaterThanOrEqual(0);
    expect(placed.offset).toBeLessThan(100);
    expect(errors).toEqual([]);
    await page.close();

    for (const path of ["/chat/about#%E0%A4%A", "/chat/about#nope"]) {
      const bad = await at(path);
      const top = await bad.page.evaluate(
        () => document.querySelector<HTMLElement>('[data-surface="about"] [data-scroll-root]')!.scrollTop,
      );
      expect(top).toBe(0);
      expect(bad.errors).toEqual([]);
      await bad.page.close();
    }
  }, 60_000);

  test("an InfoTip opens on a tap and closes on a second tap, an outside tap or Escape", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/chat/settings`);
    await page.waitForFunction(() => window.shellHarness !== undefined);
    if (process.env.INFOTIP_DEBUG) {
      page.on("console", (message) => console.log("[page]", message.text()));
      await page.evaluate(() => {
        for (const type of ["pointerdown", "pointerup", "pointercancel", "mousedown", "focus", "click", "touchstart", "touchend"]) {
          document.addEventListener(type, (event) => {
            const target = event.target as Element | null;
            console.log(type, (event as PointerEvent).pointerType ?? "", target?.getAttribute?.("aria-label") ?? target?.tagName);
          }, true);
        }
      });
    }

    // The trigger is a button named for what it explains.
    const trigger = page.getByRole("button", { name: "About agent access", exact: true });
    await trigger.waitFor();
    const describedBy = () => trigger.getAttribute("aria-describedby");
    const step = async (name: string, wait: Promise<unknown>) => {
      try {
        await wait;
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    };
    const isOpen = (name: string) =>
      step(
        name,
        page.waitForFunction(
          () => {
            const button = document.querySelector('button[aria-label="About agent access"]');
            const id = button?.getAttribute("aria-describedby");
            return !!id && document.getElementById(id)?.textContent?.includes("Public web search stays available.");
          },
          undefined,
          { timeout: 5_000 },
        ),
      );
    const isClosed = (name: string) =>
      step(
        name,
        page.waitForFunction(
          () => !document.querySelector('button[aria-label="About agent access"]')?.hasAttribute("aria-describedby"),
          undefined,
          { timeout: 5_000 },
        ),
      );

    expect(await describedBy()).toBeNull();
    await trigger.tap();
    await isOpen("a tap opens it");
    expect(await page.getByRole("tooltip").textContent()).toContain("Public web search stays available.");

    // A second tap closes it, and stays closed.
    await trigger.tap();
    await isClosed("a second tap closes it");
    await settle(page);
    expect(await describedBy()).toBeNull();

    // An outside tap closes it.
    await trigger.tap();
    await isOpen("a third tap opens it again");
    await page.getByRole("heading", { name: "Account", exact: true }).tap();
    await isClosed("an outside tap closes it");

    // Escape closes it.
    await trigger.tap();
    await isOpen("a tap after the outside tap opens it");
    await page.keyboard.press("Escape");
    await isClosed("Escape closes it");

    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("retired addresses end on the Library", async () => {
    for (const path of ["/chat/connectors/library", "/chat/meetings"]) {
      const { page, errors } = await open(path);
      await page.waitForFunction(() => window.location.pathname === "/chat/capture/library");
      await page.getByRole("heading", { name: "Meetings", exact: true }).waitFor();
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 60_000);
});
