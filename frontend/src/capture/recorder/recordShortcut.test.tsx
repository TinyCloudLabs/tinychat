import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { recordShortcutAction, useRecordShortcut, type RecordShortcutTarget, type SubscribeStartRequests } from "./recordShortcut";

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

/** The native side: one listener at a time, and a press reaches it. */
function nativeEvents() {
  let handler: (() => void) | null = null;
  let subscriptions = 0;
  const subscribe: SubscribeStartRequests = async (next) => {
    subscriptions++;
    handler = next;
    return () => { if (handler === next) handler = null; };
  };
  return {
    subscribe,
    listening: () => handler !== null,
    subscriptions: () => subscriptions,
    press: () => act(async () => handler?.()),
  };
}

function Probe(props: { enabled: boolean; target: RecordShortcutTarget; subscribe: SubscribeStartRequests }) {
  useRecordShortcut(props.enabled, props.target, props.subscribe);
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

async function render(enabled: boolean, target: RecordShortcutTarget, subscribe: SubscribeStartRequests) {
  root ??= createRoot(container());
  await act(async () => root!.render(<Probe enabled={enabled} target={target} subscribe={subscribe} />));
}

describe("recordShortcutAction", () => {
  test("idle and ready records, a recording or its receipt is opened, not ready waits, no recorder drops", () => {
    expect(recordShortcutAction({ available: true, ready: true, active: false })).toBe("record");
    expect(recordShortcutAction({ available: true, ready: true, active: true })).toBe("open");
    expect(recordShortcutAction({ available: true, ready: false, active: true })).toBe("open");
    expect(recordShortcutAction({ available: true, ready: false, active: false })).toBe("wait");
    expect(recordShortcutAction({ available: false, ready: true, active: false })).toBe("drop");
  });
});

describe("useRecordShortcut", () => {
  test("Start recording calls the recorder's own Record once per press", async () => {
    const events = nativeEvents();
    const { target, calls } = recorder();
    await render(true, target, events.subscribe);
    expect(events.listening()).toBe(true);
    expect(calls).toEqual([]);
    await events.press();
    expect(calls).toEqual(["record"]);
    await events.press();
    expect(calls).toEqual(["record", "record"]);
  });

  test("while recording it opens the recorder instead of starting another", async () => {
    const events = nativeEvents();
    const { target, calls } = recorder({ active: true });
    await render(true, target, events.subscribe);
    await events.press();
    expect(calls).toEqual(["openSheet"]);
  });

  test("a press before the recorder is ready records once it is", async () => {
    const events = nativeEvents();
    const waiting = recorder({ ready: false });
    await render(true, waiting.target, events.subscribe);
    await events.press();
    expect(waiting.calls).toEqual([]);
    const ready = { ...waiting.target, ready: true };
    await render(true, ready, events.subscribe);
    expect(waiting.calls).toEqual(["record"]);
    // Handled: a later render does not record again.
    await render(true, { ...ready }, events.subscribe);
    expect(waiting.calls).toEqual(["record"]);
  });

  test("without a recorder the press is dropped, not held for later", async () => {
    const events = nativeEvents();
    const off = recorder({ available: false });
    await render(true, off.target, events.subscribe);
    await events.press();
    await render(true, { ...off.target, available: true }, events.subscribe);
    expect(off.calls).toEqual([]);
  });

  test("off the Mac app nothing listens, and unmounting stops listening", async () => {
    const web = nativeEvents();
    await render(false, recorder().target, web.subscribe);
    expect(web.subscriptions()).toBe(0);

    const mac = nativeEvents();
    await render(true, recorder().target, mac.subscribe);
    expect(mac.listening()).toBe(true);
    await act(async () => root!.unmount());
    root = null;
    expect(mac.listening()).toBe(false);
  });
});
