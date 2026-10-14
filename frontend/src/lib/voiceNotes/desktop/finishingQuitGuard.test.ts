import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { askToQuitDuringFinishing, FINISHING_QUIT_COPY, installFinishingQuitGuard } from "./finishingQuitGuard";

test("finishing quit prompt has the exact copy and Wait keeps the window open", async () => {
  const window = new Window();
  const decision = askToQuitDuringFinishing(window.document as unknown as Document);
  const dialog = window.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain(FINISHING_QUIT_COPY);
  expect([...dialog.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Quit", "Wait"]);
  (dialog.querySelectorAll("button")[1] as HTMLElement).click();
  expect(await decision).toBe(false);
  expect(window.document.querySelector("dialog")).toBeNull();
  window.happyDOM.abort();
});

test("Quit confirms one finishing decision", async () => {
  const window = new Window();
  const decision = askToQuitDuringFinishing(window.document as unknown as Document);
  (window.document.querySelector("button") as HTMLElement).click();
  expect(await decision).toBe(true);
  window.happyDOM.abort();
});

test("close request waits once while finishing and Quit destroys the window", async () => {
  let onClose: ((event: { preventDefault(): void }) => void | Promise<void>) | null = null;
  let destroyed = 0;
  let prompted = 0;
  const unlisten = await installFinishingQuitGuard(async () => true, {
    async onCloseRequested(handler) { onClose = handler; return () => { onClose = null; }; },
    async destroy() { destroyed++; },
  }, async () => { prompted++; return true; });
  let prevented = 0;
  await onClose!({ preventDefault() { prevented++; } });
  expect({ prevented, prompted, destroyed }).toEqual({ prevented: 1, prompted: 1, destroyed: 1 });
  unlisten();
  expect(onClose).toBeNull();
});

test("close is cancelled synchronously before an async finishing check", async () => {
  let onClose!: (event: { preventDefault(): void }) => Promise<void>;
  let release!: (value: boolean) => void;
  let destroyed = 0;
  await installFinishingQuitGuard(() => new Promise<boolean>((resolve) => { release = resolve; }), {
    async onCloseRequested(handler) { onClose = handler as typeof onClose; return () => {}; },
    async destroy() { destroyed++; },
  });
  let prevented = false;
  const closing = onClose({ preventDefault() { prevented = true; } });
  expect(prevented).toBe(true);
  expect(destroyed).toBe(0);
  release(false);
  await closing;
  expect(destroyed).toBe(1);
});

test("app-menu Quit and Cmd+Q share one finishing prompt with window close", async () => {
  let onClose!: (event: { preventDefault(): void }) => Promise<void>;
  let onExit!: () => void;
  let prompts = 0;
  let quits = 0;
  let choose!: (quit: boolean) => void;
  const unlisten = await installFinishingQuitGuard(async () => true, {
    async onCloseRequested(handler) { onClose = handler as typeof onClose; return () => {}; },
    async destroy() { throw new Error("window destroy bypassed native quit"); },
  }, () => { prompts++; return new Promise((resolve) => { choose = resolve; }); },
  async (handler) => { onExit = handler; return () => {}; },
  async () => { quits++; });
  onExit();
  onExit();
  const closing = onClose({ preventDefault() {} });
  await Bun.sleep(0);
  expect(prompts).toBe(1);
  choose(false);
  await closing;
  expect(quits).toBe(0);
  onExit();
  await Bun.sleep(0);
  expect(prompts).toBe(2);
  choose(true);
  await Bun.sleep(0);
  expect(quits).toBe(1);
  unlisten();
});
