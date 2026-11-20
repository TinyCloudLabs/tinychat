import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  STOP_REQUESTED_EVENT,
  START_REQUESTED_EVENT,
  stopRequestApplies,
  useRecordShortcut,
  useStopShortcut,
  type RecordShortcutTarget,
  type StopRequests,
  type StopShortcutTarget,
} from "./recordShortcut";

// The call prompt tile's Stop, claimed beside the Start recording request: it stops a live or paused recording once
// per claim through the recorder's own Stop, and never starts anything.

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

/** The native side: one request held until it is claimed, announced to whoever listens. */
function nativeRequests() {
  let handler: (() => void) | null = null;
  let pending = false;
  let takes = 0;
  let failNext: unknown = null;
  const requests: StopRequests = {
    async subscribe(next) {
      handler = next;
      return () => { if (handler === next) handler = null; };
    },
    async take() {
      takes++;
      if (failNext !== null) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const claimed = pending;
      pending = false;
      return claimed;
    },
  };
  return {
    requests,
    takes: () => takes,
    press: () => act(async () => { pending = true; handler?.(); }),
    pressUnheard: () => { pending = true; },
    failNextClaim: (error: unknown) => { failNext = error; },
  };
}

function stopTarget(recording: boolean) {
  const calls: string[] = [];
  const target: StopShortcutTarget = { recording, stop: () => calls.push("stop") };
  return { target, calls };
}

function Probe(props: { stop: StopShortcutTarget; stops: StopRequests; record?: RecordShortcutTarget; starts?: StopRequests }) {
  useStopShortcut(true, props.stop, props.stops);
  useRecordShortcut(props.record !== undefined, props.record ?? { available: false, ready: false, active: false, record() {}, openSheet() {} },
    props.starts ?? props.stops);
  return null;
}

async function render(props: Parameters<typeof Probe>[0]) {
  root ??= createRoot(container());
  await act(async () => root!.render(<Probe {...props} />));
}

describe("useStopShortcut", () => {
  test("its own event, not the start one", () => {
    expect(STOP_REQUESTED_EVENT).toBe("exo://recorder-stop-requested");
    expect(STOP_REQUESTED_EVENT).not.toBe(START_REQUESTED_EVENT);
  });

  test("a stop request while recording stops once", async () => {
    const native = nativeRequests();
    const { target, calls } = stopTarget(true);
    await render({ stop: target, stops: native.requests });
    await native.press();
    expect(calls).toEqual(["stop"]);
    // Each new request is its own claim and its own stop.
    await native.press();
    expect(calls).toEqual(["stop", "stop"]);
    expect(native.takes()).toBe(3);
  });

  test("one stop per claim, even when the event comes twice for one request", async () => {
    const native = nativeRequests();
    const { target, calls } = stopTarget(true);
    let poke: (() => void) | null = null;
    const requests: StopRequests = {
      subscribe: async (handler) => { poke = handler; return () => {}; },
      take: native.requests.take,
    };
    await render({ stop: target, stops: requests });
    native.pressUnheard();
    await act(async () => { poke!(); poke!(); });
    expect(calls).toEqual(["stop"]);
  });

  test("applies to a live or paused recording only", () => {
    expect(stopRequestApplies({ phase: "recording", mic: { state: "recording" } } as { phase: string })).toBe(true);
    expect(stopRequestApplies({ phase: "recording", mic: { state: "paused" } } as { phase: string })).toBe(true);
    for (const phase of ["idle", "starting", "stopping", "saving", "discarding"])
      expect(stopRequestApplies({ phase })).toBe(false);
  });

  test("while paused (still the recording phase) it stops once", async () => {
    const native = nativeRequests();
    const { target, calls } = stopTarget(true);
    await render({ stop: target, stops: native.requests });
    await native.press();
    expect(calls).toEqual(["stop"]);
  });

  test("while idle it claims the request and does nothing", async () => {
    const native = nativeRequests();
    const { target, calls } = stopTarget(false);
    await render({ stop: target, stops: native.requests });
    await native.press();
    expect(calls).toEqual([]);
    // The request is spent: a recording started later is not stopped by it.
    const later = stopTarget(true);
    await render({ stop: later.target, stops: native.requests });
    await act(async () => {});
    expect(later.calls).toEqual([]);
  });

  test("a request that arrived before the listener existed is honoured", async () => {
    const native = nativeRequests();
    native.pressUnheard();
    const { target, calls } = stopTarget(true);
    await render({ stop: target, stops: native.requests });
    await act(async () => {});
    expect(calls).toEqual(["stop"]);
  });

  test("a failed claim does not stop and is logged once", async () => {
    const native = nativeRequests();
    const { target, calls } = stopTarget(true);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await render({ stop: target, stops: native.requests });
      native.failNextClaim(new Error("not allowed"));
      await native.press();
      expect(calls).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  test("a failed stop is logged once and changes nothing else", async () => {
    const native = nativeRequests();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await render({ stop: { recording: true, stop: () => { throw new Error("engine down"); } }, stops: native.requests });
      await native.press();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  test("start requests behave as before beside it, and a stop request starts nothing", async () => {
    const stops = nativeRequests();
    const starts = nativeRequests();
    const calls: string[] = [];
    const record: RecordShortcutTarget = {
      available: true, ready: true, active: false,
      record: () => calls.push("record"), openSheet: () => calls.push("openSheet"),
    };
    await render({ stop: { recording: false, stop: () => calls.push("stop") }, stops: stops.requests, record, starts: starts.requests });
    await stops.press();
    expect(calls).toEqual([]);
    await starts.press();
    expect(calls).toEqual(["record"]);
  });
});
