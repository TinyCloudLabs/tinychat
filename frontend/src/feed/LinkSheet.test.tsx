import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Window as HappyWindow } from "happy-dom";
import { installDom } from "@/test/dom";

// Radix portals do not attach in happy-dom once another file has loaded Radix without a DOM, so the sheet's chrome
// (BottomSheet: its drag, scrim, Escape and focus trap) is an inline stand-in; everything inside it is real.
// bun's mock.module is process-wide: the stand-in keeps every other export, and the real module is put back after.
const actualSheet = { ...(await import("../components/ui/bottom-sheet")) };
afterAll(() => {
  mock.module("../components/ui/bottom-sheet", () => actualSheet);
});
mock.module("../components/ui/bottom-sheet", () => ({
  ...actualSheet,
  BottomSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" aria-label={String(props.title)} {...props.contentProps}>{props.children}</div> : null,
}));
// Imported only once the stand-in is registered, so the sheet picks it up.
const { FeedLink, LinkSheetHost } = await import("./FeedLink");

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.(); restore = undefined;
});

async function mount(href: string) {
  restore = installDom();
  // No page is fetched for the frame: its load is dispatched by the test. installDom's window is happy-dom's.
  const dom = window as unknown as HappyWindow;
  dom.happyDOM.settings.disableIframePageLoading = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<><FeedLink href={href}>The report</FeedLink><LinkSheetHost /></>));
  return host.querySelector("a")!;
}

/** Clicks the link as a tap or a click sends it: the primary button, modifiers as given. */
async function click(link: HTMLAnchorElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  await act(async () => { link.dispatchEvent(event); });
  // The sheet loads from its own chunk; let the import and the sheet's mount finish.
  for (let i = 0; i < 20; i++) await act(async () => { await Bun.sleep(5); });
  return event;
}

const sheet = () => document.querySelector("[data-link-sheet]");

test("a plain click opens another site's page in the sheet, framed apart from the app, and Close shuts it", async () => {
  const link = await mount("https://example.com/reports/daily");
  expect((await click(link)).defaultPrevented).toBe(true);
  expect(sheet()!.getAttribute("aria-label")).toBe("example.com");
  const frame = sheet()!.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe("https://example.com/reports/daily");
  expect(frame.getAttribute("sandbox")!.split(" ").sort()).toEqual(["allow-forms", "allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin", "allow-scripts"]);
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(sheet()!.textContent).toContain("Loading example.com…");
  await act(async () => { frame.dispatchEvent(new Event("load")); });
  expect(sheet()!.textContent).not.toContain("Loading example.com…");
  expect(sheet()!.textContent).toContain("Page not showing? Some sites only open in a browser.");
  const open = [...sheet()!.querySelectorAll("a")].find((a) => a.textContent === "Open in browser")!;
  expect([open.getAttribute("href"), open.getAttribute("target"), open.getAttribute("rel")]).toEqual(["https://example.com/reports/daily", "_blank", "noopener noreferrer"]);
  await act(async () => (sheet()!.querySelector("button[aria-label='Close']") as HTMLButtonElement).click());
  expect(sheet()).toBeNull();
});

test("a site that refuses to be shown in a frame gets a note and Open in browser, not a blank frame", async () => {
  const link = await mount("https://github.com/acme/site/pull/42");
  await click(link);
  expect(sheet()!.querySelector("iframe")).toBeNull();
  expect(sheet()!.textContent).toContain("github.com only opens in a browser.");
  expect([...sheet()!.querySelectorAll("a")].some((a) => a.getAttribute("href") === "https://github.com/acme/site/pull/42" && a.textContent === "Open in browser")).toBe(true);
});

test("cmd-click and middle click keep the browser's new tab and open no sheet", async () => {
  const link = await mount("https://example.com/");
  expect((await click(link, { metaKey: true })).defaultPrevented).toBe(false);
  expect((await click(link, { button: 1 })).defaultPrevented).toBe(false);
  expect(sheet()).toBeNull();
});

test("a mailto link stays a plain link", async () => {
  const link = await mount("mailto:sam@example.com");
  expect((await click(link)).defaultPrevented).toBe(false);
  expect(sheet()).toBeNull();
});
