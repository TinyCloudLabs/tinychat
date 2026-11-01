// TC-2081: no five-minute warning under the silent safety cap; after "Keep going" the new limit is warned about once.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";

import { installReactTestEnv, mount } from "./final/shell/hookTestUtil";
import { LIMIT_WARNING_TEXT, useLimitNotifications } from "./limitNotifications";
import { initialRecorderState, type RecorderState } from "./recorderReducer";

const HOUR = 60 * 60_000;
function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

let sent: { title: string; body?: string }[];
let restoreEnv: () => void;
const saved = { notification: Object.getOwnPropertyDescriptor(globalThis, "Notification"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };

beforeEach(() => {
  restoreEnv = installReactTestEnv();
  sent = [];
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: class {
    static get permission() { return "granted" as NotificationPermission; }
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) { sent.push({ title, body: options?.body }); }
    close() {}
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { hasFocus: () => false } });
});

afterEach(() => {
  for (const [name, descriptor] of [["Notification", saved.notification], ["document", saved.document]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  restoreEnv();
});

function Probe(props: { state: RecorderState }) {
  useLimitNotifications(props.state, () => {});
  return null;
}

/** A recording `msBeforeWarning` short of the warning for its limit, checkpointed now. */
function recording(limitMs: number, msBeforeWarning: number, patch: Partial<RecorderState> = {}): RecorderState {
  return { ...initialRecorderState, phase: "recording", recordingId: "rec-1", maxDurationMs: limitMs,
    elapsedMs: limitMs - 5 * 60_000 - msBeforeWarning, elapsedAt: Date.now(), mic: { state: "recording", reason: null }, ...patch };
}

describe("limit warnings and the automatic-stop setting", () => {
  test("a recording under the silent cap never warns, even right at the warning time", async () => {
    const root = mount();
    await root.render(createElement(Probe, { state: recording(8 * HOUR, 20, { autoStop: false }) }));
    await wait(60);
    expect(sent).toEqual([]);
    await root.unmount();
  });

  test("after Keep going the new limit gets its own warning, once", async () => {
    const root = mount();
    await root.render(createElement(Probe, { state: recording(HOUR, 20) }));
    await wait(60);
    expect(sent).toEqual([{ title: "Exo", body: LIMIT_WARNING_TEXT }]);
    await root.render(createElement(Probe, { state: recording(2 * HOUR, 20) }));
    await wait(60);
    expect(sent).toHaveLength(2);
    await root.render(createElement(Probe, { state: recording(2 * HOUR, -1000) }));
    await wait(20);
    expect(sent).toHaveLength(2);
    await root.unmount();
  });
});
