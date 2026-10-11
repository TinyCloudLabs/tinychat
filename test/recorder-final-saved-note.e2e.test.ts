// The saved voice note (D3) on the desktop page and the phone sheet, driven in a real browser over
// frontend/src/harness/screens/savedNote.tsx (the "interactive-*" screens: an in-memory note store and, for the
// first note, twenty seconds of stored silence for the player).
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
/**
 * Chromium with its desktop autoplay policy on (headless Chromium waives it by default). Chromium
 * counts any earlier click on the page, so a play() that comes late still passes there: the
 * calls recorded by `recordPlays` are what show the first tap plays from inside the click, which
 * is what iOS WebKit needs. `browser` waives the policy for the other specs.
 */
let strictBrowser: Browser;
let server: ReturnType<typeof serveHarness>;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await engine.launch({
    headless: true,
    args:
      engineName === "chromium"
        ? ["--autoplay-policy=no-user-gesture-required"]
        : [],
  });
  strictBrowser =
    engineName === "chromium"
      ? await engine.launch({ headless: true, args: ["--autoplay-policy=document-user-activation-required"] })
      : browser;
}, 120_000);

afterAll(async () => {
  await Promise.race([
    strictBrowser === browser
      ? browser?.close()
      : Promise.all([browser?.close(), strictBrowser?.close()]),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  server?.stop(true);
});

const PAGE = { screen: "interactive-page", platform: "tauri", width: 1280, height: 800 };
const SHEET = { screen: "interactive-sheet", platform: "ios", width: 390, height: 844 };
const PAGE_EMPTY = { ...PAGE, screen: "interactive-page-empty" };
const SHEET_EMPTY = { ...SHEET, screen: "interactive-sheet-empty" };

async function open(
  target: { screen: string; platform: string; width: number; height: number },
  theme = "light",
  options: { browser?: Browser; init?: () => void } = {},
) {
  const context = await (options.browser ?? browser).newContext({
    viewport: { width: target.width, height: target.height },
    colorScheme: theme === "dark" ? "dark" : "light",
    reducedMotion: "reduce",
  });
  if (options.init) await context.addInitScript(options.init);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error" &&
      !text.startsWith("Failed to load resource") &&
      !text.includes('Viewport argument key "interactive-widget" not recognized')
    ) {
      errors.push(text);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.port}/?screen=saved-note-${target.screen}&theme=${theme}&platform=${target.platform}`,
  );
  await page.waitForSelector(
    '[data-testid="saved-note-page"], [data-testid="saved-note-sheet"]',
  );
  return { page, errors };
}

/** Records every media play() call: whether it ran inside a click's dispatch, and the element's source then. Everything stays muted. */
function recordPlays() {
  const plays: { inClick: boolean; src: string | null }[] = [];
  let inClick = false;
  (window as unknown as { __plays: typeof plays }).__plays = plays;
  addEventListener("click", () => { inClick = true; }, true);
  addEventListener("click", () => { inClick = false; });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    this.muted = true;
    plays.push({ inClick, src: this.getAttribute("src") });
    return play.call(this);
  };
}
const recordedPlays = (page: Page) =>
  page.evaluate(() => (window as unknown as { __plays: { inClick: boolean; src: string | null }[] }).__plays.slice());

const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms = 8000,
) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const shown = (locator: Locator) =>
  locator.waitFor({ state: "visible", timeout: 8000 });
const gone = (locator: Locator) =>
  locator.waitFor({ state: "hidden", timeout: 8000 });
const focused = (locator: Locator) =>
  until(`${locator} to have focus`, () =>
    locator.evaluate((el) => el === document.activeElement),
  );

const notes = (page: Page) => page.getByTestId("saved-note-notes");
const field = (page: Page) => notes(page).locator("textarea");
const rendered = (page: Page) => page.getByTestId("saved-note-rendered");
const edited = (page: Page) => page.getByTestId("saved-note-edited");
const button = (page: Page, name: string) =>
  notes(page).getByRole("button", { name, exact: true });
const confirm = (page: Page) => page.getByRole("alertdialog");
const saves = (page: Page) =>
  page.evaluate(() => window.exoSavedNote?.saves.slice() ?? []);
const editedText = async (page: Page) => (await edited(page).innerText()).trim();

/** The rendered note shows `text` (the renderer loads lazily, so it first says "Rendering…"). */
const renders = (page: Page, text: string) =>
  until(`the note to render "${text}"`, async () =>
    (await rendered(page).innerText()).includes(text),
  );

/** Edit, then types `text` at the end of the note. */
async function typeAtEnd(page: Page, text: string) {
  await button(page, "Edit").click();
  await shown(field(page));
  await focused(field(page));
  await page.keyboard.type(text);
}

describe.serial(`recorder-final saved note, ${engineName}`, () => {
  test("dark sheet: Play audio has a visible edge against its surface", async () => {
    const { page, errors } = await open(SHEET, "dark");
    const play = page.getByTestId("note-audio-play");
    await shown(play);
    const edge = await play.evaluate((button) => {
      const skin = button.closest(".soft-skin")!;
      const buttonStyle = getComputedStyle(button);
      return {
        border: buttonStyle.borderTopColor,
        width: buttonStyle.borderTopWidth,
        surface: getComputedStyle(skin).backgroundColor,
      };
    });
    expect(edge.width).not.toBe("0px");
    expect(edge.border).not.toBe(edge.surface);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("page: Edit → type → ⌘S saves, shows the new text and adds the Edited line (none before the first saved edit)", async () => {
    const { page, errors } = await open(PAGE);
    await shown(rendered(page));
    expect(await edited(page).count()).toBe(0);
    expect(await button(page, "Copy").count()).toBe(1);

    await typeAtEnd(page, "\n\nAlso: park the budget.");
    expect(await notes(page).getAttribute("data-editing")).toBe("true");
    expect((await notes(page).innerText()).toLowerCase()).toContain("editing");
    await page.keyboard.press("Meta+s");
    await gone(field(page));
    await shown(rendered(page));
    await renders(page, "park the budget");
    expect(await saves(page)).toHaveLength(1);
    expect((await saves(page))[0]).toEndWith("Also: park the budget.");
    await shown(edited(page));
    expect(await editedText(page)).toMatch(/^Edited /);
    // Focus returns to Edit.
    await focused(button(page, "Edit"));
    expect(errors).toEqual([]);
  });

  test("page: Cancel with changes asks first; Keep editing keeps the text, Discard changes restores the note", async () => {
    const { page, errors } = await open(PAGE);
    await shown(rendered(page));
    await typeAtEnd(page, " more");
    await button(page, "Cancel").click();
    await shown(confirm(page));
    expect(await confirm(page).innerText()).toContain("Discard your changes?");
    await confirm(page).getByRole("button", { name: "Keep editing" }).click();
    await gone(confirm(page));
    expect(await field(page).inputValue()).toEndWith(" more");

    await button(page, "Cancel").click();
    await confirm(page).getByRole("button", { name: "Discard changes" }).click();
    await gone(confirm(page));
    await shown(rendered(page));
    await renders(page, "Book the venue");
    expect(await rendered(page).innerText()).not.toContain("more");
    expect(await saves(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("page: leaving mid-edit keeps the draft until the note is opened again", async () => {
    const { page, errors } = await open(PAGE);
    await shown(rendered(page));
    await typeAtEnd(page, " kept draft");
    await page.getByRole("button", { name: "Back to Capture" }).click();
    await gone(page.getByTestId("saved-note-page"));
    await page.locator('[data-source-id="rec-0928"]').first().click();
    await shown(field(page));
    expect(await field(page).inputValue()).toEndWith(" kept draft");
    expect(await saves(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  for (const { name, width, textScale } of [
    { name: "320 px wide", width: 320, textScale: "100%" },
    { name: "320 px wide at 200% text", width: 320, textScale: "200%" },
    { name: "390 px wide at 200% text", width: 390, textScale: "200%" },
  ]) {
    test(`sheet: the player fits ${name}`, async () => {
      const { page, errors } = await open({ ...SHEET, width });
      await page.addStyleTag({ content: `:root:root { font-size: ${textScale} !important; }` });
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(textScale === "200%" ? "32px" : "16px");
      await page.getByTestId("note-audio-play").click();
      const controls = page.getByTestId("note-audio-controls");
      await shown(controls);
      await until("the player to know its length", () =>
        page.getByTestId("note-audio-player").evaluate((el: HTMLAudioElement) => el.readyState >= 1),
      );
      const fit = await controls.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const parts = ["note-audio-toggle", "note-audio-time"].map((id) => el.querySelector(`[data-testid=${id}]`)!.getBoundingClientRect());
        const range = el.querySelector("input[type=range]")!.getBoundingClientRect();
        const all = [...parts, range];
        const overlap = all.some((a, i) => all.some((b, j) => i < j && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
        const root = document.scrollingElement!;
        return {
          pageOverflow: root.scrollWidth - root.clientWidth,
          left: box.left,
          right: box.right,
          viewport: window.innerWidth,
          overlap,
          partsInside: all.every((part) => part.left >= box.left - 1 && part.right <= box.right + 1),
          rangeWidth: range.width,
          rangeHeight: range.height,
          timeText: el.querySelector("[data-testid=note-audio-time]")!.textContent,
        };
      });
      expect(fit.pageOverflow).toBe(0);
      expect(fit.left).toBeGreaterThanOrEqual(0);
      expect(fit.right).toBeLessThanOrEqual(fit.viewport);
      expect(fit.partsInside).toBe(true);
      expect(fit.overlap).toBe(false);
      expect(fit.rangeWidth).toBeGreaterThanOrEqual(96);
      expect(fit.rangeHeight).toBeGreaterThanOrEqual(24);
      expect(fit.timeText).toMatch(/^0:0\d \/ 0:\d\d$/);
      expect(errors).toEqual([]);
    });
  }

  describe.serial("playback under the browser's own autoplay policy", () => {
    test("sheet: the first tap plays, from the tap itself, and the finished clip plays again", async () => {
      const { page, errors } = await open(SHEET, "light", { browser: strictBrowser, init: recordPlays });
      const audio = page.getByTestId("note-audio-player");
      await page.getByTestId("note-audio-play").click();
      await shown(page.getByTestId("note-audio-controls"));
      await until("the first tap to be playing", () =>
        audio.evaluate((el: HTMLAudioElement) => !el.paused && el.currentTime > 0.3),
      );
      expect(await audio.evaluate((el: HTMLAudioElement) => el.muted)).toBe(true);
      // The first call is the tap's own, made before the audio had a source; the second follows the load.
      const plays = await recordedPlays(page);
      expect(plays[0]).toEqual({ inClick: true, src: null });
      expect(plays.length).toBe(2);
      expect(plays[1].src).toStartWith("blob:");
      expect(await page.getByTestId("note-audio-toggle").getAttribute("aria-label")).toBe("Pause");

      await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = el.duration - 0.4; });
      await until("the clip to end", () => audio.evaluate((el: HTMLAudioElement) => el.ended));
      await until("the button to offer Play again", async () =>
        (await page.getByTestId("note-audio-toggle").getAttribute("aria-label")) === "Play",
      );

      await page.getByTestId("note-audio-toggle").click();
      await until("the replay to be playing from the start", () =>
        audio.evaluate((el: HTMLAudioElement) => !el.paused && !el.ended && el.currentTime > 0.2 && el.currentTime < 5),
      );
      expect((await recordedPlays(page)).at(-1)).toEqual({ inClick: true, src: expect.stringMatching(/^blob:/) });
      expect(errors).toEqual([]);
      await page.close();
    });

    test("sheet: a seek made while the audio is loading is applied once it is", async () => {
      const { page, errors } = await open(SHEET, "light", { browser: strictBrowser, init: recordPlays });
      const audio = page.getByTestId("note-audio-player");
      await page.getByTestId("note-audio-play").click();
      await shown(page.getByTestId("note-audio-controls"));
      const range = page.getByRole("slider", { name: "Seek" });
      await range.focus();
      await page.keyboard.press("End");
      await until("the player to be at the end", () =>
        audio.evaluate((el: HTMLAudioElement) => el.readyState >= 1 && el.currentTime > el.duration - 1),
      );
      expect(await range.getAttribute("aria-valuetext")).toMatch(/^0:\d\d of 0:\d\d$/);
      expect(errors).toEqual([]);
      await page.close();
    });
  });

  test("page: a moment button seeks the player", async () => {
    const { page, errors } = await open(PAGE);
    await shown(rendered(page));
    const moment = rendered(page).getByRole("button", { name: "Play from 0:08" });
    await shown(moment);
    await moment.click();
    await shown(page.getByTestId("note-audio-controls"));
    const audio = page.getByTestId("note-audio-player");
    await until("the player to be at or past 0:08", () =>
      audio.evaluate((el: HTMLAudioElement) => el.readyState >= 1 && el.currentTime >= 8),
    );
    expect(await audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeLessThan(20);
    expect(errors).toEqual([]);
  });

  test("sheet: Edit → type → Save shows the new text and adds the Edited line", async () => {
    const { page, errors } = await open(SHEET);
    await shown(rendered(page));
    expect(await edited(page).count()).toBe(0);
    await typeAtEnd(page, "\n\nsheet line");
    await button(page, "Save").click();
    await gone(field(page));
    await shown(rendered(page));
    await renders(page, "sheet line");
    expect(await saves(page)).toHaveLength(1);
    await shown(edited(page));
    expect(await editedText(page)).toMatch(/^Edited /);
    expect(errors).toEqual([]);
  });

  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
    // What is left of those two above the on-screen keyboard.
    { width: 390, height: 480 },
    { width: 320, height: 380 },
  ]) {
    test(`sheet ${size.width}x${size.height}: the formatting bar stays inside the visible sheet and off the field in Edit mode, at the top, middle and end of the scroll`, async () => {
      const { page, errors } = await open({ ...SHEET, ...size });
      await shown(rendered(page));
      await button(page, "Edit").click();
      await shown(field(page));
      await shown(page.locator(".sn-sheet .nt-wtools"));
      const check = () =>
        page.evaluate(() => {
          const rect = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const sheet = rect(".sn-sheet");
          const scroll = rect(".sn-sheet-scroll");
          const bar = rect(".sn-sheet .nt-wtools");
          const field = rect(".sn-sheet .nt-wta");
          // The part of the field the scrolling body shows.
          const top = Math.max(field.top, scroll.top);
          const bottom = Math.min(field.bottom, scroll.bottom);
          return {
            inSheet:
              bar.top >= sheet.top - 0.5 &&
              bar.bottom <= sheet.bottom + 0.5 &&
              bar.left >= sheet.left - 0.5 &&
              bar.right <= sheet.right + 0.5,
            overField: bottom > top && bar.top < bottom && bar.bottom > top,
          };
        });
      const scrollTo = (at: "top" | "middle" | "end") =>
        page.locator(".sn-sheet-scroll").evaluate((el, where) => {
          const room = el.scrollHeight - el.clientHeight;
          el.scrollTop = where === "top" ? 0 : where === "middle" ? room / 2 : room;
        }, at);
      for (const at of ["top", "middle", "end"] as const) {
        await scrollTo(at);
        expect({ at, ...(await check()) }).toEqual({ at, inSheet: true, overField: false });
      }
      expect(errors).toEqual([]);
    });
  }

  test("sheet: Cancel with changes asks first; Discard changes returns to the note", async () => {
    const { page, errors } = await open(SHEET);
    await shown(rendered(page));
    await typeAtEnd(page, " unsaved");
    await button(page, "Cancel").click();
    await shown(confirm(page));
    await confirm(page).getByRole("button", { name: "Keep editing" }).click();
    await gone(confirm(page));
    expect(await field(page).inputValue()).toEndWith(" unsaved");
    await button(page, "Cancel").click();
    await confirm(page).getByRole("button", { name: "Discard changes" }).click();
    await gone(confirm(page));
    await shown(rendered(page));
    await renders(page, "Book the venue");
    expect(await rendered(page).innerText()).not.toContain("unsaved");
    expect(await saves(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("sheet: closing with changes asks first", async () => {
    const { page, errors } = await open(SHEET);
    await shown(rendered(page));
    await typeAtEnd(page, " unsaved");
    await page.getByRole("button", { name: "Close" }).click();
    await shown(confirm(page));
    await confirm(page).getByRole("button", { name: "Keep editing" }).click();
    await gone(confirm(page));
    expect(await page.getByTestId("saved-note-sheet").count()).toBe(1);
    expect(errors).toEqual([]);
  });

  for (const [name, target] of [
    ["page", PAGE_EMPTY],
    ["sheet", SHEET_EMPTY],
  ] as const) {
    test(`${name}: an empty note offers Add a note, which opens the writer and saves`, async () => {
      const { page, errors } = await open(target);
      const add = page.getByTestId("saved-note-add");
      await shown(add);
      expect(await add.innerText()).toBe("Add a note");
      expect(await button(page, "Edit").count()).toBe(0);
      expect(await button(page, "Copy").count()).toBe(0);
      expect(await edited(page).count()).toBe(0);

      await add.click();
      await shown(field(page));
      await focused(field(page));
      await page.keyboard.type("First thoughts");
      await button(page, "Save").click();
      await shown(rendered(page));
      await renders(page, "First thoughts");
      expect(await saves(page)).toEqual(["First thoughts"]);
      await shown(edited(page));
      expect(errors).toEqual([]);
    });
  }
});
