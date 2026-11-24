import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { ReportContext } from "@/lib/reportBug/context";
import type { ReportSigner, SendInput, SendOutcome } from "@/lib/reportBug/send";
import { REPORT_BUG_STRINGS as S } from "@/lib/reportBug/strings";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in; everything inside is real.
const actualSheet = { ...(await import("../components/ui/responsive-sheet")) };
afterAll(() => { mock.module("../components/ui/responsive-sheet", () => actualSheet); });
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; dismissible?: boolean }) =>
    props.open ? <div role="dialog" data-dismissible={String(props.dismissible ?? true)}><h2>{props.title}</h2><p>{props.description}</p>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { ReportBugSheet } = await import("./ReportBugSheet");

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const context: ReportContext = { app: "TinyCloud One 0.20.4", platform: "ios", os: "18", screen: "feed", client_time: "2026-11-24T10:00:00.000Z", online: true, trigger: "screenshot" };
const signer: ReportSigner = { sessionDid: "did:key:z6Mk", siwe: "siwe", siweSignature: "0x", sign: async () => new Uint8Array(64) };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

function mount(over: { trigger?: "screenshot" | "menu"; screenshot?: { bytes: Uint8Array; sensitive: boolean } | null; signer?: ReportSigner | null; outcomes?: SendOutcome[] } = {}) {
  restore = installDom();
  const sent: SendInput[] = [];
  const outcomes = [...(over.outcomes ?? [{ kind: "sent" } as SendOutcome])];
  const events: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  act(() => mounted!.render(
    <ReportBugSheet
      open
      trigger={over.trigger ?? "screenshot"}
      screenshot={over.screenshot === undefined ? { bytes: JPEG, sensitive: false } : over.screenshot}
      signer={over.signer === undefined ? signer : over.signer}
      canAttachFile={false}
      context={{ ...context, trigger: over.trigger ?? "screenshot" }}
      recentErrors={[{ age_s: 3, msg: "TypeError: boom" }]}
      origin="https://feedback.example"
      send={async (input) => { sent.push(input); return outcomes.shift() ?? { kind: "sent" }; }}
      onOpenChange={(open) => events.push(open ? "open" : "close")}
      onSent={() => events.push("sent")}
    />,
  ));
  return { host, sent, events };
}

const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (node: Element | undefined) => {
  expect(node).toBeTruthy();
  await act(async () => { node!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
};
async function type(value: string) {
  const area = document.querySelector("textarea")!;
  await act(async () => {
    // happy-dom has no native `input` support, so React reads the change of the focused field on key events.
    area.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
}

test("after a screenshot: the screenshot is attached, with Remove; Remove means the request carries no screenshot", async () => {
  const { sent } = mount();
  expect(text()).toContain(S.title);
  expect(text()).toContain(S.subtitleScreenshot);
  expect(text()).toContain(S.screenshotAttached);
  expect(text()).toContain(S.screenshotWarning);
  expect(document.querySelector("img")).toBeTruthy();
  await click(button(S.remove));
  expect(text()).toContain(S.noScreenshot);
  expect(document.querySelector("img")).toBeNull();
  await type("The feed froze.");
  await click(button(S.send));
  expect(sent).toHaveLength(1);
  expect(sent[0].screenshot).toBeNull();
  expect(sent[0].happened).toBe("The feed froze.");
});

test("Add it back re-attaches the same screenshot", async () => {
  const { sent } = mount();
  await click(button(S.remove));
  await click(button(S.addBack));
  await type("x");
  await click(button(S.send));
  expect(sent[0].screenshot).toEqual(JPEG);
});

test("a sensitive screen starts with the screenshot detached; Add it attaches it", async () => {
  const { sent } = mount({ screenshot: { bytes: JPEG, sensitive: true } });
  expect(text()).toContain(S.sensitive);
  expect(document.querySelector("img")).toBeNull();
  await click(button(S.addIt));
  expect(document.querySelector("img")).toBeTruthy();
  await type("x");
  await click(button(S.send));
  expect(sent[0].screenshot).toEqual(JPEG);
});

test("an empty note is not sent", async () => {
  const { sent } = mount();
  await click(button(S.send));
  expect(sent).toHaveLength(0);
  expect(text()).toContain(S.errorNoText);
});

test("signed out: no screenshot offered, the account line says so, and the report goes unsigned", async () => {
  const { sent } = mount({ signer: null, trigger: "menu" });
  expect(text()).toContain(S.subtitleMenu);
  expect(text()).toContain(S.accountSignedOut);
  expect(text()).not.toContain(S.screenshotAttached);
  expect(document.querySelector("img")).toBeNull();
  await type("x");
  await click(button(S.send));
  expect(sent[0].signer).toBeNull();
  expect(sent[0].screenshot).toBeNull();
});

test("signed in shows the account line; See what we send lists the facts and recent errors", async () => {
  mount();
  expect(text()).toContain(S.accountSignedIn);
  expect(text()).toContain(S.whatWeSend);
  expect(text()).toContain(S.whatWeSendLink);
  expect(text()).toContain("TinyCloud One 0.20.4");
  expect(text()).toContain("TypeError: boom");
});

test("a failed send keeps the note and the screenshot and offers Try again", async () => {
  const { sent } = mount({ outcomes: [{ kind: "failed" }, { kind: "sent" }] });
  await type("x");
  await click(button(S.send));
  expect(text()).toContain(S.errorNetwork);
  expect(document.querySelector("textarea")!.value).toBe("x");
  expect(document.querySelector("img")).toBeTruthy();
  await click(button(S.tryAgain));
  expect(sent).toHaveLength(2);
  expect(sent[1].screenshot).toEqual(JPEG);
  expect(text()).toContain(S.success);
});

test("too many, success, and sent without the screenshot say so", async () => {
  mount({ outcomes: [{ kind: "too_many" }, { kind: "sent_without_screenshot" }] });
  await type("x");
  await click(button(S.send));
  expect(text()).toContain(S.errorTooMany);
  await click(button(S.send));
  expect(text()).toContain(S.success);
  expect(text()).toContain(S.errorScreenshotRefused);
});

test("Not now closes; a send reports sent", async () => {
  const first = mount();
  await click(button(S.notNow));
  expect(first.events).toEqual(["close"]);
  act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  const second = mount();
  await type("x");
  await click(button(S.send));
  expect(second.events).toEqual(["sent"]);
});
