import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { createTauriDesktopCaptureExtras } from "@/lib/voiceNotes/desktop/tauriDesktopCaptureExtras";
import type { DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { createFakeDesktopCaptureExtras, type FakeDesktopCaptureExtrasOptions } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { CaptureSettings } from "./CaptureSettings";

// "Offer to record when a call starts", in the ⚙︎ popover over the scripted extras: the first row of Meetings, shown
// only when the app answers `{ enabled, supported: true }`, independent of the other switches.

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
  return {
    host,
    toggle: () => find("switch-call-prompt"),
    gear: () => find("capture-settings-button"),
    systemAudio: () => find("switch-system-audio"),
    reopen: async () => {
      await act(async () => find("capture-settings-button")!.click());
      await act(async () => find("capture-settings-button")!.click());
      await settle();
    },
  };
}

async function open(options: FakeDesktopCaptureExtrasOptions) {
  const fake = createFakeDesktopCaptureExtras(options);
  return { fake, ...(await mountSettings(fake.extras)) };
}

describe("CaptureSettings, offer to record when a call starts", () => {
  test("the first row of Meetings, with its label and no description, on as the app says", async () => {
    const { fake, toggle, host } = await open({ callPrompt: {} });
    expect(fake.calls).toContain("callPrompt.get");
    const row = toggle();
    expect(row?.getAttribute("role")).toBe("switch");
    expect(row?.getAttribute("aria-checked")).toBe("true");
    expect(row?.hasAttribute("aria-describedby")).toBe(false);
    const label = host.ownerDocument.getElementById(row!.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("Offer to record when a call starts");
    expect(label?.parentElement?.textContent).toBe("Offer to record when a call starts");
    const meetings = host.querySelector('section[aria-labelledby="cs-meet-h"]')!;
    expect(meetings.querySelector('[role="switch"]')).toBe(row);
  });

  test("off as the app says", async () => {
    const { toggle } = await open({ callPrompt: { enabled: false } });
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  test("hidden without the member, off macOS, and for any answer that is not the agreed one", async () => {
    const absent = await open({});
    expect(absent.toggle()).toBeNull();
    expect(absent.systemAudio()).not.toBeNull();
    await unmountSettings();
    const unsupported = await open({ callPrompt: { supported: false } });
    expect(unsupported.toggle()).toBeNull();
    expect(unsupported.systemAudio()).not.toBeNull();
    await unmountSettings();
    for (const answer of [null, true, "on", { enabled: true }, { enabled: "yes", supported: true }, { enabled: true, supported: "yes" }]) {
      const fake = createFakeDesktopCaptureExtras({ callPrompt: {} });
      fake.extras.callPrompt!.get = async () => answer;
      const view = await mountSettings(fake.extras);
      expect(view.toggle()).toBeNull();
      expect(view.systemAudio()).not.toBeNull();
      await unmountSettings();
    }
  });

  test("a passing failure hides it for this opening only: one error, and the next opening asks again", async () => {
    const fake = createFakeDesktopCaptureExtras({ callPrompt: {} });
    fake.failNext("callPrompt.get", "watcher busy");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = await mountSettings(fake.extras);
      expect(view.toggle()).toBeNull();
      expect(view.systemAudio()).not.toBeNull();
      expect(error.mock.calls.filter((call) => String(call[0]).includes("call prompt")).length).toBe(1);
      await view.reopen();
      expect(view.toggle()?.getAttribute("aria-checked")).toBe("true");
      expect(fake.calls.filter((call) => call.startsWith("callPrompt"))).toEqual(["callPrompt.get", "callPrompt.get"]);
    } finally { error.mockRestore(); }
  });

  test("an answer that is not the agreed one hides it for this opening only", async () => {
    const fake = createFakeDesktopCaptureExtras({ callPrompt: {} });
    const get = fake.extras.callPrompt!.get;
    let answers = 0;
    fake.extras.callPrompt!.get = async () => (answers++ === 0 ? { enabled: "yes" } : get());
    const view = await mountSettings(fake.extras);
    expect(view.toggle()).toBeNull();
    await view.reopen();
    expect(view.toggle()).not.toBeNull();
  });

  test("supported: false hides it for the session: no later opening asks again", async () => {
    const { fake, reopen, toggle } = await open({ callPrompt: { supported: false } });
    expect(toggle()).toBeNull();
    await reopen();
    expect(toggle()).toBeNull();
    expect(fake.calls.filter((call) => call.startsWith("callPrompt"))).toEqual(["callPrompt.get"]);
  });

  test("a refusal that says the command does not exist hides it for the session, with no error", async () => {
    const fake = createFakeDesktopCaptureExtras({ callPrompt: {} });
    let asked = 0;
    fake.extras.callPrompt!.get = async () => { asked++; throw "Command call_prompt_get not found"; };
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = await mountSettings(fake.extras);
      expect(view.toggle()).toBeNull();
      await view.reopen();
      expect(view.toggle()).toBeNull();
      expect(asked).toBe(1);
      expect(error.mock.calls.filter((call) => String(call[0]).includes("call prompt"))).toEqual([]);
    } finally { error.mockRestore(); }
  });

  test("a build without the commands: hidden, asked once, and no error", async () => {
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
      await view.reopen();
      expect(view.toggle()).toBeNull();
      expect(extras.callPrompt).toBeUndefined();
      expect(invoked.filter((command) => command.startsWith("call_prompt"))).toEqual(["call_prompt_get"]);
      expect(error.mock.calls.filter((call) => String(call[0]).includes("call prompt"))).toEqual([]);
    } finally { error.mockRestore(); info.mockRestore(); }
  });

  test("a popover opened again reads it again", async () => {
    const { fake, reopen, toggle } = await open({ callPrompt: {} });
    await reopen();
    expect(toggle()).not.toBeNull();
    expect(fake.calls.filter((call) => call === "callPrompt.get").length).toBe(2);
  });

  test("toggling asks the app, waits for it, and changes nothing else", async () => {
    const fake = createFakeDesktopCaptureExtras({ systemAudio: true, callNames: { enabled: true, permission: "granted" }, callPrompt: {} });
    let finish: () => void = () => {};
    const set = fake.extras.callPrompt!.set;
    fake.extras.callPrompt!.set = (enabled) => new Promise<void>((resolve, reject) => {
      finish = () => void set(enabled).then(resolve, reject);
    });
    const view = await mountSettings(fake.extras);
    await act(async () => view.toggle()!.click());
    expect(view.toggle()?.hasAttribute("disabled")).toBe(true);
    expect(view.toggle()?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    await settle();
    expect(fake.calls).toContain("callPrompt.set:false");
    expect(view.toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(view.toggle()?.hasAttribute("disabled")).toBe(false);
    expect(view.systemAudio()?.getAttribute("aria-checked")).toBe("true");
    expect(fake.calls.filter((call) => call.startsWith("systemAudio.set") || call.startsWith("callNames.set"))).toEqual([]);
    await act(async () => view.toggle()!.click());
    await act(async () => finish());
    await settle();
    expect(view.toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  test("the Mac's audio switch leaves it alone", async () => {
    const { fake, systemAudio, toggle } = await open({ systemAudio: true, callPrompt: {} });
    await act(async () => systemAudio()!.click());
    await settle();
    expect(fake.calls).toContain("systemAudio.set:false");
    expect(fake.calls.filter((call) => call.startsWith("callPrompt.set"))).toEqual([]);
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  test("a failed change keeps the switch as it was and says so", async () => {
    const { fake, toggle } = await open({ callPrompt: {} });
    fake.failNext("callPrompt.set", "watcher stopped");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => toggle()!.click());
      await settle();
      expect(toggle()?.getAttribute("aria-checked")).toBe("true");
      expect(toggle()?.hasAttribute("disabled")).toBe(false);
      const alert = toggle()!.parentElement!.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Could not change this setting");
      expect(alert?.textContent).toContain("watcher stopped");
      expect(error).toHaveBeenCalledTimes(1);
      // A later change that lands clears the error.
      await act(async () => toggle()!.click());
      await settle();
      expect(toggle()?.getAttribute("aria-checked")).toBe("false");
      expect(toggle()!.parentElement!.querySelector('[role="alert"]')).toBeNull();
    } finally { error.mockRestore(); }
  });
});
