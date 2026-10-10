// The final recorder in a browser tab (W2), driven in a real browser over the real recorder on the fake
// plugin with a web engine's capabilities (frontend/src/harness/screens/recorderFinalWeb.tsx, the
// interactive screen): the tab title follows the recording and is restored, the leave-page guard exists
// only while recording, and the keep-open notice shows once per recording.
//
//   EXO_UI_ENGINE=chromium   webkit (default: Exo's WKWebView) or chromium
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chromium,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engineName === "chromium" ? chromium : webkit;

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 700, height: 800 };

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await engine.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await Promise.race([
    browser?.close(),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  server?.stop(true);
});

const contexts: BrowserContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

async function open(size = DESKTOP) {
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: "reduce",
  });
  contexts.push(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource") &&
      !message.text().startsWith("Viewport argument key")
    )
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.port}/?screen=recorder-final-web-interactive&theme=dark&platform=web`;
  const html = await (await page.request.get(url)).text();
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  await page.goto(url);
  return { page, errors, title };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms = 5000,
) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
};
const shown = (locator: Locator) =>
  locator.waitFor({ state: "visible", timeout: 5000 });
const attr = (locator: Locator, name: string, value: string) =>
  until(
    `${name}="${value}"`,
    async () => (await locator.getAttribute(name)) === value,
  );

const tabTitle = (page: Page) => page.evaluate(() => document.title);
const titleIs = (page: Page, pattern: RegExp) =>
  until(`the tab title to match ${pattern}`, async () =>
    pattern.test(await tabTitle(page)),
  );
// What the browser asks of a page about to be left: true when it will prompt.
const leaveGuarded = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
const toasts = (page: Page, message: string) =>
  page.getByText(message, { exact: true });

const view = (page: Page) => page.getByTestId("desktop-recorder");
const ring = (page: Page) => view(page).locator("button.pr-ring");

const RECORDING = /^● \d+:\d\d · Exo$/;
const PAUSED = /^❚❚ \d+:\d\d · Exo$/;

describe.serial(`web recorder chrome (${engineName})`, () => {
  test("the tab title follows the recording and is restored exactly after discard", async () => {
    const { page, errors, title } = await open();
    await shown(view(page));
    await titleIs(page, RECORDING);
    const first = await tabTitle(page);
    await until("the title time to advance", async () => (await tabTitle(page)) !== first);

    await ring(page).click();
    await attr(ring(page), "aria-label", "Resume recording");
    await titleIs(page, PAUSED);
    await ring(page).click();
    await titleIs(page, RECORDING);

    await page.getByRole("button", { name: "Discard recording" }).first().click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard recording" })
      .click();
    await until("the title to be restored", async () => (await tabTitle(page)) === title);
    expect(title).not.toBe("");
    expect(errors).toEqual([]);
  });

  test("the leave-page guard is there only while recording or paused", async () => {
    const { page } = await open();
    await shown(view(page));
    await titleIs(page, RECORDING);
    expect(await leaveGuarded(page)).toBe(true);

    await ring(page).click();
    await titleIs(page, PAUSED);
    expect(await leaveGuarded(page)).toBe(true);

    await page.getByRole("button", { name: "Discard recording" }).first().click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard recording" })
      .click();
    await until("the guard to be removed", async () => !(await leaveGuarded(page)));
  });

  test("the keep-open notice shows once at the start and not again on pause and resume", async () => {
    const { page } = await open();
    const notice = toasts(page, "Keep this tab open while you record");
    await shown(notice);
    expect(await notice.count()).toBe(1);
    await until("the notice to go", async () => (await notice.count()) === 0, 6000);

    await ring(page).click();
    await attr(ring(page), "aria-label", "Resume recording");
    await ring(page).click();
    await attr(ring(page), "aria-label", "Pause recording");
    await sleep(800);
    expect(await notice.count()).toBe(0);
  });

  test("the phone-width page asks to keep the page open", async () => {
    const { page } = await open(PHONE);
    await shown(page.getByTestId("phone-recorder"));
    await shown(toasts(page, "Keep this page open while you record"));
    expect(await toasts(page, "Keep this tab open while you record").count()).toBe(0);
  });
});
