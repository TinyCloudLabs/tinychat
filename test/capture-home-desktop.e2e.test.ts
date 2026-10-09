// The desktop Capture home (D2), driven in a real browser (frontend/src/harness/screens/captureHomeDesktop.tsx,
// the interactive screen: the real recorder over the fake native plugin, on the Library fixture): the header's
// gear and Connect existing meetings open and close with focus returning, the filter chips narrow Recent, and
// Back to recording restores the recorder view you left.
//
//   EXO_UI_ENGINE=webkit   run it in WebKit instead (default: chromium)
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

const engine = process.env.EXO_UI_ENGINE === "webkit" ? webkit : chromium;

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;

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
const gone = (locator: Locator) =>
  locator.waitFor({ state: "hidden", timeout: 5000 });
const attr = (locator: Locator, name: string, value: string) =>
  until(
    `${name}="${value}"`,
    async () => (await locator.getAttribute(name)) === value,
  );
const focused = (locator: Locator) =>
  until("focus", () => locator.evaluate((el) => el === document.activeElement));

async function open(size = { width: 1280, height: 800 }) {
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
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=capture-home-desktop-interactive&theme=dark&platform=tauri`,
  );
  await shown(page.getByTestId("desktop-capture-home"));
  await shown(page.getByTestId("recent-item").first());
  return { page, errors };
}

const home = (page: Page) => page.getByTestId("desktop-capture-home");
const recorder = (page: Page) => page.getByTestId("desktop-recorder");
const rows = (page: Page) => home(page).getByTestId("recent-item");
const titles = async (page: Page) =>
  (await rows(page).allInnerTexts()).map((text) => text.split("\n")[0]);
const NOTE = /^Voice note/;

describe.serial(`desktop capture home (${engine.name()})`, () => {
  test("shows Capture, the idle start button and Recent in the wide layout", async () => {
    const { page, errors } = await open();
    await shown(page.getByRole("heading", { level: 1, name: "Capture" }));
    await shown(page.getByTestId("voice-note-record"));
    await shown(page.getByRole("link", { name: "Library" }));
    expect(await page.getByTestId("capture-open-recorder").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test("the gear opens Capture settings and Escape closes it, returning focus to the gear", async () => {
    const { page, errors } = await open();
    const gear = page.getByTestId("capture-settings-button");
    await attr(gear, "aria-expanded", "false");
    await gear.click();
    await shown(page.getByTestId("capture-settings"));
    await attr(gear, "aria-expanded", "true");
    await page.keyboard.press("Escape");
    await gone(page.getByTestId("capture-settings"));
    await attr(gear, "aria-expanded", "false");
    await focused(gear);
    expect(errors).toEqual([]);
  });

  test("Connect existing meetings opens the sources window and Escape returns focus to it", async () => {
    const { page, errors } = await open();
    const connect = page.getByTestId("capture-connect-meetings");
    await connect.click();
    const window_ = page.getByTestId("meeting-sources-window");
    await shown(window_);
    await page.keyboard.press("Escape");
    await gone(window_);
    await focused(connect);
    expect(errors).toEqual([]);
  });

  test("the filter chips are a toggle group that narrows Recent", async () => {
    const { page, errors } = await open();
    const all = page.getByTestId("recent-filter-all");
    const notes = page.getByTestId("recent-filter-note");
    const meetings = page.getByTestId("recent-filter-meeting");
    await attr(all, "aria-pressed", "true");
    await attr(notes, "aria-pressed", "false");
    const everything = await titles(page);
    expect(everything.length).toBeGreaterThan(2);

    await notes.click();
    await attr(notes, "aria-pressed", "true");
    await attr(all, "aria-pressed", "false");
    const noteTitles = await titles(page);
    expect(noteTitles.length).toBeGreaterThan(0);
    expect(noteTitles.every((title) => NOTE.test(title))).toBe(true);

    await meetings.click();
    await attr(meetings, "aria-pressed", "true");
    await attr(notes, "aria-pressed", "false");
    const meetingTitles = await titles(page);
    expect(meetingTitles.length).toBeGreaterThan(0);
    expect(meetingTitles.some((title) => NOTE.test(title))).toBe(false);

    await all.click();
    await attr(all, "aria-pressed", "true");
    expect(await titles(page)).toEqual(everything);
    expect(errors).toEqual([]);
  });

  test("Start recording opens the recorder; minimising shows Back to recording, which restores the same recording", async () => {
    const { page, errors } = await open();
    await page.getByTestId("voice-note-record").click();
    await shown(recorder(page));

    await page.getByRole("button", { name: "Minimise recorder" }).click();
    await gone(recorder(page));
    const back = page.getByTestId("capture-open-recorder");
    await shown(back);
    expect(await back.textContent()).toMatch(/Back to recording\s*·\s*\d+:\d{2}/);
    expect(await page.getByTestId("voice-note-record").count()).toBe(0);

    await back.click();
    await shown(recorder(page));
    expect(await recorder(page).getByRole("timer").textContent()).toMatch(
      /\d+:\d{2}/,
    );
    expect(errors).toEqual([]);
  });

  test("at 900 wide the home keeps its layout in the rail", async () => {
    const { page, errors } = await open({ width: 900, height: 600 });
    expect(await home(page).getAttribute("data-layout")).toBe("rail");
    await shown(page.getByTestId("voice-note-record"));
    await shown(page.getByTestId("capture-settings-button"));
    expect(errors).toEqual([]);
  });
});
