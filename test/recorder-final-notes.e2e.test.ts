// Moments and the notes sheet on the final phone recorder (TC-881), driven in a real browser over
// frontend/src/harness/screens/recorderFinalPhoneInteractive.tsx (the "notes" screen: 0:42 in, notes kept in memory).
//
//   EXO_UI_ENGINE=chromium   webkit (default: Exo's WKWebView) or chromium
import {
  afterAll,
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
  type Locator,
  type Page,
} from "playwright";
import { buildHarness, serveHarness } from "./exo-ui/harness-server";

const engineName = process.env.EXO_UI_ENGINE ?? "webkit";
const engine = engineName === "chromium" ? chromium : webkit;

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

async function open() {
  const page = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    })
  ).newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource")
    )
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=recorder-final-phone-interactive-notes&theme=light&platform=ios`,
  );
  await page.waitForSelector("[data-testid=phone-recorder]");
  return { page, errors };
}

const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms = 5000,
) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const shown = (locator: Locator) =>
  locator.waitFor({ state: "visible", timeout: 5000 });
const gone = (locator: Locator) =>
  locator.waitFor({ state: "hidden", timeout: 5000 });
const focused = (locator: Locator) =>
  until(`${locator} to have focus`, () =>
    locator.evaluate((el) => el === document.activeElement),
  );

const plus = (page: Page) =>
  page.getByRole("button", { name: "Note this moment" });
const viewNotes = (page: Page) =>
  page.getByRole("button", { name: "View notes" });
const field = (page: Page) =>
  page.getByRole("textbox", { name: "Note for 0:42" });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Notes" });
const writer = (page: Page) => sheet(page).locator("textarea");
const calls = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { exoNotes: { calls: string[] } }
    ).exoNotes.calls.slice(),
  );

describe.serial(`recorder-final notes, ${engineName}`, () => {
  test("＋ opens the field, Enter saves a moment, View notes opens the sheet and focus returns", async () => {
    const { page, errors } = await open();
    expect(await viewNotes(page).count()).toBe(0);
    await plus(page).click();
    await shown(field(page));
    await focused(field(page));
    expect(await field(page).getAttribute("placeholder")).toBe(
      "What's happening at 0:42?",
    );
    await page.keyboard.type("Hunter mentions the TTL");
    await page.keyboard.press("Enter");
    await gone(field(page));
    await shown(viewNotes(page));

    await viewNotes(page).click();
    await shown(sheet(page));
    // First open is Preview: the rendered line, from the lazily loaded WASM renderer.
    await shown(sheet(page).locator(".fmd"));
    expect(await sheet(page).locator(".fmd").innerText()).toContain(
      "Hunter mentions the TTL",
    );
    expect(await sheet(page).locator(".fmd").innerText()).toContain("0:42");

    await sheet(page).getByRole("button", { name: "Write" }).click();
    await shown(writer(page));
    await focused(writer(page));
    expect(await writer(page).inputValue()).toBe(
      "- **0:42** Hunter mentions the TTL",
    );
    // Typing autosaves; the line continues the list on Enter.
    await writer(page).evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(el.value.length, el.value.length),
    );
    await page.keyboard.press("Enter");
    await page.keyboard.type("second item");
    expect(await writer(page).inputValue()).toBe(
      "- **0:42** Hunter mentions the TTL\n- second item",
    );

    await sheet(page).getByRole("button", { name: "Preview" }).click();
    await until("the preview to include the new item", async () =>
      (
        await sheet(page)
          .locator(".fmd")
          .innerText()
          .catch(() => "")
      ).includes("second item"),
    );

    await page.keyboard.press("Escape");
    await gone(sheet(page));
    await focused(viewNotes(page));

    // The last view is remembered: the sheet reopens in Preview.
    await viewNotes(page).click();
    await shown(sheet(page).locator(".fmd"));
    await sheet(page).getByRole("button", { name: "Done" }).click();
    await gone(sheet(page));
    await focused(viewNotes(page));
    expect(errors).toEqual([]);
  });

  test("Escape cancels a moment and leaves no note", async () => {
    const { page, errors } = await open();
    await plus(page).click();
    await shown(field(page));
    await page.keyboard.type("never mind");
    await page.keyboard.press("Escape");
    await gone(field(page));
    expect(await viewNotes(page).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test("Discard says the notes go too, only once there is a note", async () => {
    const { page, errors } = await open();
    const discard = page.getByRole("button", { name: "Discard recording" });
    await discard.click();
    const alert = page.getByRole("alertdialog");
    await shown(alert);
    expect(await alert.innerText()).toContain("You'll lose 0:42 of audio.");
    expect(await alert.innerText()).not.toContain("your notes");
    await page.getByRole("button", { name: "Keep recording" }).click();
    await gone(alert);

    await plus(page).click();
    await page.keyboard.type("keep this");
    await page.keyboard.press("Enter");
    await shown(viewNotes(page));
    await discard.click();
    await shown(alert);
    expect(await alert.innerText()).toContain(
      "You'll lose 0:42 of audio and your notes.",
    );
    await alert.getByRole("button", { name: "Discard recording" }).click();
    await until("the discard call", async () =>
      (await calls(page)).includes("discard"),
    );
    expect(errors).toEqual([]);
  });
});
