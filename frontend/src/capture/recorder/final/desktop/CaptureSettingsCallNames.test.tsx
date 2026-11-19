import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { createTauriDesktopCaptureExtras } from "@/lib/voiceNotes/desktop/tauriDesktopCaptureExtras";
import type { DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { createFakeDesktopCaptureExtras, type FakeDesktopCaptureExtrasOptions } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { CaptureSettings } from "./CaptureSettings";

// Names in the call, in the ⚙︎ popover over the scripted extras: one switch of this Mac, off by default, shown only
// where the app can read call windows; while it is on and macOS has not allowed it yet, one Open System Settings.

const noInputs = {
  list: async () => ({ inputs: [], selectedId: null, activeId: null }),
  select: async () => {},
  subscribe: () => () => {},
};

let root: Root | null = null;
let restoreDom: (() => void) | null = null;

async function unmountSettings() {
  if (root) await act(async () => root!.unmount());
  root = null;
  restoreDom?.();
  restoreDom = null;
}
afterEach(unmountSettings);

const settle = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function mountSettings(extras: DesktopCaptureExtras) {
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<CaptureSettings variant="app" inputs={noInputs} extras={extras} defaultOpen />));
  await settle();
  const find = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return { host, toggle: () => find("switch-call-names"), openSettings: () => find("call-names-open-settings"),
    gear: () => find("capture-settings-button"), systemAudio: () => find("switch-system-audio") };
}

async function open(options: FakeDesktopCaptureExtrasOptions) {
  const fake = createFakeDesktopCaptureExtras(options);
  return { fake, ...(await mountSettings(fake.extras)) };
}

describe("CaptureSettings, names in the call", () => {
  test("off by default, read when the popover opens", async () => {
    const { fake, toggle, openSettings } = await open({ callNames: {} });
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(openSettings()).toBeNull();
    expect(fake.calls).toContain("callNames.get");
  });

  test("hidden off macOS, where the app has no such setting, and where it cannot say", async () => {
    expect((await open({ callNames: { permission: "unsupported" } })).toggle()).toBeNull();
    await unmountSettings();
    const absent = await open({});
    expect(absent.toggle()).toBeNull();
    expect(absent.systemAudio()).not.toBeNull();
    await unmountSettings();
    const fake = createFakeDesktopCaptureExtras({ callNames: {} });
    fake.failNext("callNames.get", "reader busy");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await mountSettings(fake.extras);
      expect(failed.toggle()).toBeNull();
      expect(failed.systemAudio()).not.toBeNull();
    } finally { error.mockRestore(); }
  });

  test("an answer that is not the agreed one hides the switch and throws nothing", async () => {
    for (const answer of [null, "granted", { enabled: "yes", permission: "granted" }, { enabled: true, permission: "maybe" }]) {
      const fake = createFakeDesktopCaptureExtras({ callNames: { enabled: true, permission: "missing" } });
      fake.extras.callNames!.get = async () => answer;
      const view = await mountSettings(fake.extras);
      expect(view.toggle()).toBeNull();
      expect(view.systemAudio()).not.toBeNull();
      await unmountSettings();
    }
  });

  test("a build without the commands: the switch stays hidden, and after the first refusal no popover open asks again", async () => {
    const invoked: string[] = [];
    const answers: Record<string, unknown> = { recorder_models_list: [], recorder_models_get: null, recorder_system_audio_get: false };
    const bridge = {
      invoke: async (command: string) => {
        invoked.push(command);
        if (command in answers) return answers[command];
        throw `Command ${command} not found`;
      },
      listen: async () => () => {},
    };
    const extras = createTauriDesktopCaptureExtras(bridge as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const view = await mountSettings(extras);
      expect(view.toggle()).toBeNull();
      expect(view.systemAudio()).not.toBeNull();
      await act(async () => view.gear()!.click());
      await act(async () => view.gear()!.click());
      await settle();
      expect(view.systemAudio()).not.toBeNull();
      expect(view.toggle()).toBeNull();
      expect(invoked.filter((command) => command.startsWith("call_names"))).toEqual(["call_names_get"]);
      expect(error.mock.calls.filter((call) => String(call[0]).includes("call names"))).toEqual([]);
    } finally { error.mockRestore(); info.mockRestore(); }
  });

  test("turning it on asks the app; while macOS has not allowed it, one button opens System Settings", async () => {
    const { fake, toggle, openSettings } = await open({ callNames: {} });
    await act(async () => toggle()!.click());
    await settle();
    expect(fake.calls).toContain("callNames.set:true");
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(openSettings()?.textContent).toBe("Open System Settings");
    await act(async () => openSettings()!.click());
    expect(fake.calls.at(-1)).toBe("callNames.openSettings");
  });

  test("while it waits for macOS the popover checks every second; once allowed, the button goes", async () => {
    const { fake, openSettings } = await open({ callNames: { enabled: true, permission: "missing" } });
    expect(openSettings()).not.toBeNull();
    fake.setCallNamesPermission("granted");
    await settle(1_200);
    expect(openSettings()).toBeNull();
    const checks = fake.calls.filter((call) => call === "callNames.get").length;
    // Allowed: the checks stop.
    await settle(1_200);
    expect(fake.calls.filter((call) => call === "callNames.get").length).toBe(checks);
  });

  test("an answer that comes late, after a quick on-then-off, does not put the old value back", async () => {
    const fake = createFakeDesktopCaptureExtras({ callNames: { permission: "granted" } });
    const view = await mountSettings(fake.extras);
    // From here each read is held until the test answers it.
    const held: Array<(answer: unknown) => void> = [];
    fake.extras.callNames!.get = () => new Promise((resolve) => { held.push(resolve); });
    await act(async () => view.toggle()!.click());
    await settle();
    expect(view.toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => view.toggle()!.click());
    await settle();
    expect(held).toHaveLength(2);
    // The read made after "off" answers first; the one made after "on" answers last, with what was true then.
    await act(async () => held[1]!({ enabled: false, permission: "granted" }));
    await act(async () => held[0]!({ enabled: true, permission: "granted" }));
    await settle();
    expect(view.toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  test("turning it off removes the button; a failed change keeps the value and says so", async () => {
    const { fake, toggle, openSettings } = await open({ callNames: { enabled: true, permission: "missing" } });
    fake.failNext("callNames.set", "denied");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => toggle()!.click());
      await settle();
    } finally { error.mockRestore(); }
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(toggle()?.closest(".cs-tgl")?.textContent).toContain("Could not change this setting: denied");
    await act(async () => toggle()!.click());
    await settle();
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(openSettings()).toBeNull();
    expect(fake.calls.filter((call) => call.startsWith("callNames.set"))).toEqual(["callNames.set:false", "callNames.set:false"]);
  });
});
