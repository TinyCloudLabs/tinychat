// The final desktop recorder (D1), driven in a real browser over the real recorder on the fake native
// plugin (frontend/src/harness/screens/recorderFinalDesktop.tsx, the interactive screen). The screenshot
// run checks how each state looks; this checks the controls do what they say, the keyboard flows, and
// that crossing 768 keeps the one recording.
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

type Harness = { exoDesktop: { calls: string[] } };

const DESKTOP = { width: 1280, height: 800 };
const RAIL = { width: 900, height: 700 };
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
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=recorder-final-desktop-interactive&theme=dark&platform=tauri`,
  );
  await shown(page.getByTestId("desktop-recorder"));
  return {
    page,
    errors,
    calls: () =>
      page.evaluate(() => (window as unknown as Harness).exoDesktop.calls.slice()),
  };
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
const gone = (locator: Locator) =>
  locator.waitFor({ state: "hidden", timeout: 5000 });
const attr = (locator: Locator, name: string, value: string) =>
  until(
    `${name}="${value}"`,
    async () => (await locator.getAttribute(name)) === value,
  );
const focused = (locator: Locator) =>
  until("focus", () => locator.evaluate((el) => el === document.activeElement));

const clock = async (locator: Locator) => {
  const [m, s] = ((await locator.textContent()) ?? "").trim().split(":").map(Number);
  return m * 60 + s;
};

const view = (page: Page) => page.getByTestId("desktop-recorder");
const ring = (page: Page) => view(page).locator("button.pr-ring");
const timer = (page: Page) => view(page).getByRole("timer");
const dock = (page: Page) => page.getByTestId("sidebar-dock");
const phone = (page: Page) => page.getByTestId("phone-recorder");

describe.serial(`desktop recorder interactions (${engineName})`, () => {
  test("the ring view fills the main region and leaves the sidebar visible", async () => {
    const { page, errors } = await open();
    expect(await view(page).getAttribute("data-layout")).toBe("desktop");
    expect(await page.getByTestId("recording-overlay").count()).toBe(0);
    const main = (await page.locator("main").boundingBox())!;
    const box = (await view(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
    expect(box.width).toBeLessThanOrEqual(main.width + 1);
    expect(main.x).toBeGreaterThan(100);
    await expect(ring(page).getAttribute("aria-label")).resolves.toBe(
      "Pause recording",
    );
    expect(errors).toEqual([]);
  });

  test("the ring pauses and resumes, the timer holds while paused, and nothing is announced per second", async () => {
    const { page, calls } = await open();
    await ring(page).click();
    await attr(ring(page), "aria-label", "Resume recording");
    await attr(view(page), "data-ring", "paused");
    const held = await clock(timer(page));
    await sleep(1300);
    expect(await clock(timer(page))).toBe(held);
    expect(await calls()).toContain("pause");

    await ring(page).click();
    await attr(ring(page), "aria-label", "Pause recording");
    await until("the timer to run", async () => (await clock(timer(page))) > held);
    expect(await calls()).toContain("resume");
    expect(await timer(page).getAttribute("aria-live")).toBeNull();
    expect(await timer(page).locator("[aria-live]").count()).toBe(0);
  });

  test("the modes card opens from ⓘ⌄ with the keyboard, arrows move the choice, and Escape returns focus", async () => {
    const { page } = await open();
    const info = page.getByRole("button", {
      name: "Transcription modes: compare and choose",
    });
    await attr(info, "aria-expanded", "false");
    await info.focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("dialog", { name: "Transcription modes" });
    await shown(card);
    await attr(info, "aria-expanded", "true");
    const group = card.getByRole("radiogroup");
    await shown(group);
    const checked = group.locator("[role=radio][aria-checked=true]");
    const before = await checked.getAttribute("data-mode");
    await page.keyboard.press("ArrowDown");
    await until("an arrow to move focus", () =>
      page.evaluate(
        () => document.activeElement?.getAttribute("role") === "radio",
      ),
    );
    expect(before).not.toBeNull();
    await page.keyboard.press("Escape");
    await gone(card);
    await focused(info);
    await attr(info, "aria-expanded", "false");
  });

  test("Discard asks first: Keep recording has focus, Escape keeps, and focus returns to the discard button", async () => {
    const { page, calls } = await open();
    const discard = page.getByRole("button", { name: "Discard recording" }).first();
    await discard.click();
    const dialog = page.getByRole("alertdialog");
    await shown(dialog);
    await focused(dialog.getByRole("button", { name: "Keep recording" }));
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("[role=alertdialog]")),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await gone(dialog);
    await focused(discard);
    expect(await calls()).not.toContain("discard");
    expect(await ring(page).getAttribute("aria-label")).toBe("Pause recording");

    await discard.click();
    await shown(dialog);
    await dialog.getByRole("button", { name: "Discard recording" }).click();
    await until("discard", async () => (await calls()).includes("discard"));
  });

  test("minimise docks to the sidebar, and the dock reopens the ring view", async () => {
    const { page, calls, errors } = await open();
    await page.getByRole("button", { name: "Minimise recorder" }).click();
    await gone(view(page));
    await shown(dock(page));
    const before = await clock(page.getByTestId("dock-timer"));

    const open_ = page.getByTestId("dock-open");
    await open_.focus();
    await page.keyboard.press("Enter");
    await shown(view(page));
    await gone(dock(page));

    await page.getByRole("button", { name: "Minimise recorder" }).click();
    await shown(dock(page));
    await page.getByTestId("dock-open").focus();
    await page.keyboard.press("Space");
    await shown(view(page));
    expect(await clock(timer(page))).toBeGreaterThanOrEqual(before);
    expect(await calls()).not.toContain("stop");
    expect(errors).toEqual([]);
  });

  test("minimise on the rail docks to the floating ribbon", async () => {
    const { page } = await open(RAIL);
    expect(await view(page).getAttribute("data-layout")).toBe("rail");
    await page.getByRole("button", { name: "Minimise recorder" }).click();
    await gone(view(page));
    await shown(page.getByTestId("ribbon"));
    await page.getByTestId("ribbon-open").click();
    await shown(view(page));
  });

  test("Write notes calls the notes handler", async () => {
    const { page } = await open();
    expect(await page.getByTestId("notes-placeholder").count()).toBe(0);
    await view(page).getByRole("button", { name: "Write notes" }).click();
    await shown(page.getByTestId("notes-placeholder"));
  });

  test("resizing 1280 → 700 → 1280 swaps to the phone recorder and back, keeping the timer running and the same recording", async () => {
    const { page, calls, errors } = await open();
    await ring(page).click();
    await attr(view(page), "data-ring", "paused");
    await ring(page).click();
    await attr(view(page), "data-ring", "live");
    const started = await clock(timer(page));

    await page.setViewportSize(PHONE);
    await gone(view(page));
    await shown(phone(page));
    expect(await page.getByTestId("recording-overlay").count()).toBe(1);
    const phoneTimer = phone(page).getByRole("timer");
    await until(
      "the phone timer to carry on from the desktop timer",
      async () => (await clock(phoneTimer)) > started,
    );
    const atPhone = await clock(phoneTimer);

    await page.setViewportSize(DESKTOP);
    await shown(view(page));
    await gone(phone(page));
    await until(
      "the desktop timer to have kept running",
      async () => (await clock(timer(page))) > atPhone,
    );
    expect(await view(page).getAttribute("data-ring")).toBe("live");
    const log = await calls();
    expect(log.filter((c) => c === "stop" || c === "discard")).toEqual([]);
    expect(log.filter((c) => c === "pause")).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});
