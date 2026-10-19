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
let permission: NotificationPermission;
let focused: boolean;
let restoreEnv: () => void;
const saved = { notification: Object.getOwnPropertyDescriptor(globalThis, "Notification"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };

beforeEach(() => {
  restoreEnv = installReactTestEnv();
  sent = [];
  permission = "granted";
  focused = false;
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: class {
    static get permission() { return permission; }
    onclick: (() => void) | null = null;
    constructor(title: string, options?: NotificationOptions) { sent.push({ title, body: options?.body }); }
    close() {}
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { hasFocus: () => focused } });
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

/** A one-hour recording `msBeforeWarning` short of its five-minute warning, checkpointed now. */
function recording(msBeforeWarning: number, patch: Partial<RecorderState> = {}): RecorderState {
  return { ...initialRecorderState, phase: "recording", recordingId: "rec-1", maxDurationMs: HOUR,
    elapsedMs: 55 * 60_000 - msBeforeWarning, elapsedAt: Date.now(), mic: { state: "recording", reason: null }, ...patch };
}

describe("recording limit notifications", () => {
  test("in the background with permission: one warning five minutes before, one at the automatic stop", async () => {
    const root = mount();
    await root.render(createElement(Probe, { state: recording(20) }));
    expect(sent).toEqual([]);
    await wait(60);
    expect(sent).toEqual([{ title: "Exo", body: LIMIT_WARNING_TEXT }]);
    // A later checkpoint for the same recording does not warn again.
    await root.render(createElement(Probe, { state: recording(-1000) }));
    await wait(20);
    expect(sent).toHaveLength(1);

    const stopped = { ...recording(-5 * 60_000), phase: "saving" as const, limitNotice: "Stopped at the 1-hour limit.", limitStopMs: HOUR };
    await root.render(createElement(Probe, { state: stopped }));
    expect(sent[1]).toEqual({ title: "Exo", body: "Exo stopped recording at the 1-hour limit. Your recording is saved." });
    // Saving finishing is not another stop.
    await root.render(createElement(Probe, { state: { ...stopped, phase: "idle", outcome: "saved" } }));
    expect(sent).toHaveLength(2);
    await root.unmount();
  });

  test("Off names the 3-hour limit", async () => {
    const root = mount();
    await root.render(createElement(Probe, { state: recording(HOUR) }));
    await root.render(createElement(Probe, { state: { ...recording(HOUR), phase: "saving", limitStopMs: 3 * HOUR } }));
    expect(sent).toEqual([{ title: "Exo", body: "Exo stopped recording at the 3-hour limit. Your recording is saved." }]);
    await root.unmount();
  });

  test("nothing while Exo is focused, or without permission", async () => {
    for (const [isFocused, allowed] of [[true, "granted"], [false, "default"], [false, "denied"]] as const) {
      focused = isFocused;
      permission = allowed;
      const root = mount();
      await root.render(createElement(Probe, { state: recording(10) }));
      await wait(40);
      await root.render(createElement(Probe, { state: { ...recording(-5 * 60_000), phase: "saving", limitStopMs: HOUR } }));
      await root.unmount();
    }
    expect(sent).toEqual([]);
  });

  test("a manual Stop sends nothing, and a paused recording does not warn", async () => {
    const root = mount();
    await root.render(createElement(Probe, { state: recording(10, { mic: { state: "paused", reason: "user" } }) }));
    await wait(40);
    await root.render(createElement(Probe, { state: { ...recording(HOUR), phase: "saving" } }));
    await root.render(createElement(Probe, { state: { ...recording(HOUR), phase: "idle", outcome: "saved" } }));
    await wait(20);
    expect(sent).toEqual([]);
    await root.unmount();
  });
});
