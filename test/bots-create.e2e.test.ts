import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

import { buildHarness, serveHarness } from "./exo-ui/harness-server";

setDefaultTimeout(30_000);

let browser: Browser;
let server: ReturnType<typeof serveHarness>;
let page: Page | undefined;

beforeAll(async () => {
  server = serveHarness(await buildHarness());
  browser = await chromium.launch();
}, 120_000);

afterEach(async () => { await page?.close(); });
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function open(screen = "bots-create") {
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.port}/?screen=${screen}&theme=light&platform=web`);
  const dialog = page.getByRole("dialog", { name: "New bot" });
  await dialog.waitFor();
  return {
    dialog, name: dialog.getByLabel("Name your bot"), create: dialog.getByRole("button", { name: "Create", exact: true }),
    status: dialog.getByRole("status"),
  };
}

test("Create is disabled until named, then submits with the selected avatar", async () => {
  const { dialog, name, create } = await open();
  expect(await create.isDisabled()).toBe(true);
  await name.fill("   ");
  expect(await create.isDisabled()).toBe(true);
  await name.fill("N".repeat(25));
  expect(await create.isDisabled()).toBe(true);
  await name.fill(`  ${"N".repeat(24)}  `);
  expect(await create.isEnabled()).toBe(true);
  await name.fill("  Notes  ");
  const shape = dialog.getByRole("radio", { name: "Sprout", exact: true });
  const colour = dialog.getByRole("radio", { name: "Teal", exact: true });
  await shape.locator("..").click();
  await colour.locator("..").click();
  expect(await shape.isChecked()).toBe(true);
  expect(await colour.isChecked()).toBe(true);
  await create.click();
  await dialog.waitFor({ state: "hidden" });
  const output = page!.locator("[data-created-bot]");
  expect(JSON.parse((await output.getAttribute("data-created-bot"))!)).toMatchObject({ name: "Notes", shape: "sprout", colour: "teal" });
});

test("a duplicate name is refused regardless of case and surrounding space", async () => {
  const { name, create, status } = await open();
  await name.fill("  mAiN  ");
  expect(await create.isDisabled()).toBe(true);
  expect(await status.textContent()).toBe("You already have a bot with that name.");
});

test("the dialog shows the cap and blocks Create even with an unused name", async () => {
  const { name, create, status } = await open("bots-create-at-cap");
  await name.fill("Notes");
  expect(await create.isDisabled()).toBe(true);
  expect(await status.textContent()).toBe("You have 3 bots, the most your account can have. Delete a bot other than Main to make a new one.");
});

test("the table shows the Main-only notice when the plan includes one private bot", async () => {
  const { name, create, status } = await open("bots-create-main-at-cap");
  await name.fill("Notes");
  expect(await create.isDisabled()).toBe(true);
  expect(await status.textContent()).toBe("Your plan includes 1 private bot, and Main is it.");
});
