import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { recordShortcutAction, useRecordShortcut, type RecordShortcutTarget, type StartRequests } from "./recordShortcut";

const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

/** The native side: it holds one request until it is claimed, and pokes the listener when there is one. */
function nativeRequests() {
  let handler: (() => void) | null = null;
  let subscriptions = 0;
  let pending = false;
  const requests: StartRequests = {
    async subscribe(next) {
      subscriptions++;
      handler = next;
      return () => { if (handler === next) handler = null; };
    },
    async take() {
      const claimed = pending;
      pending = false;
      return claimed;
    },
  };
  return {
    requests,
    listening: () => handler !== null,
    subscriptions: () => subscriptions,
    /** A shortcut press or the menu item: held natively, then announced to whoever listens. */
    press: () => act(async () => { pending = true; handler?.(); }),
    /** A press while the webview has no listener yet. */
    pressUnheard: () => { pending = true; },
  };
}

function Probe(props: { enabled: boolean; target: RecordShortcutTarget; requests: StartRequests; waitMs?: number }) {
  useRecordShortcut(props.enabled, props.target, props.requests, props.waitMs);
  return null;
}

function recorder(patch: Partial<RecordShortcutTarget> = {}) {
  const calls: string[] = [];
  const target: RecordShortcutTarget = {
    available: true, ready: true, active: false,
    record: () => calls.push("record"),
    openSheet: () => calls.push("openSheet"),
    ...patch,
  };
  return { target, calls };
}

async function render(enabled: boolean, target: RecordShortcutTarget, requests: StartRequests, waitMs?: number) {
  root ??= createRoot(container());
  await act(async () => root!.render(<Probe enabled={enabled} target={target} requests={requests} waitMs={waitMs} />));
}

describe("recordShortcutAction", () => {
  test("idle and ready records, a recording or its receipt is opened, otherwise it waits", () => {
    expect(recordShortcutAction({ available: true, ready: true, active: false })).toBe("record");
    expect(recordShortcutAction({ available: true, ready: true, active: true })).toBe("open");
    expect(recordShortcutAction({ available: true, ready: false, active: true })).toBe("open");
    expect(recordShortcutAction({ available: true, ready: false, active: false })).toBe("wait");
    expect(recordShortcutAction({ available: false, ready: true, active: false })).toBe("wait");
  });
});

describe("useRecordShortcut", () => {
  test("Start recording calls the recorder's own Record once per press", async () => {
    const native = nativeRequests();
    const { target, calls } = recorder();
    await render(true, target, native.requests);
    expect(native.listening()).toBe(true);
    expect(calls).toEqual([]);
    await native.press();
    expect(calls).toEqual(["record"]);
    await native.press();
    expect(calls).toEqual(["record", "record"]);
  });

  test("while recording it opens the recorder instead of starting another", async () => {
    const native = nativeRequests();
    const { target, calls } = recorder({ active: true });
    await render(true, target, native.requests);
    await native.press();
    expect(calls).toEqual(["openSheet"]);
  });

  test("a press made before the listener existed is claimed once it starts listening", async () => {
    const native = nativeRequests();
    native.pressUnheard();
    const { target, calls } = recorder();
    await render(true, target, native.requests);
    await act(async () => {});
    expect(calls).toEqual(["record"]);
    // Claimed: a remount (a webview reload) does not record it again.
    await act(async () => root!.unmount());
    root = null;
    await render(true, target, native.requests);
    await act(async () => {});
    expect(calls).toEqual(["record"]);
  });

  test("a press before the recorder exists or is ready records once it is", async () => {
    const native = nativeRequests();
    const waiting = recorder({ available: false, ready: false });
    await render(true, waiting.target, native.requests);
    await native.press();
    await render(true, { ...waiting.target, available: true }, native.requests);
    expect(waiting.calls).toEqual([]);
    const ready = { ...waiting.target, available: true, ready: true };
    await render(true, ready, native.requests);
    expect(waiting.calls).toEqual(["record"]);
    // Handled: a later render does not record again.
    await render(true, { ...ready }, native.requests);
    expect(waiting.calls).toEqual(["record"]);
  });

  test("a press the recorder never becomes ready for is dropped after the wait", async () => {
    const native = nativeRequests();
    const off = recorder({ available: false });
    await render(true, off.target, native.requests, 20);
    await native.press();
    await act(async () => { await Bun.sleep(40); });
    await render(true, { ...off.target, available: true }, native.requests, 20);
    expect(off.calls).toEqual([]);
  });

  test("a second press while waiting restarts the wait", async () => {
    const native = nativeRequests();
    const off = recorder({ available: false });
    await render(true, off.target, native.requests, 80);
    await native.press();
    await act(async () => { await Bun.sleep(50); });
    await native.press();
    // Past the first press's wait, within the second's.
    await act(async () => { await Bun.sleep(50); });
    await render(true, { ...off.target, available: true }, native.requests, 80);
    expect(off.calls).toEqual(["record"]);
  });

  test("off the Mac app nothing listens, and unmounting stops listening", async () => {
    const web = nativeRequests();
    await render(false, recorder().target, web.requests);
    expect(web.subscriptions()).toBe(0);

    const mac = nativeRequests();
    await render(true, recorder().target, mac.requests);
    expect(mac.listening()).toBe(true);
    await act(async () => root!.unmount());
    root = null;
    expect(mac.listening()).toBe(false);
  });
});
