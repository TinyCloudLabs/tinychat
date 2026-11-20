import { describe, expect, spyOn, test } from "bun:test";
import { readCallPromptState } from "../desktopCaptureExtras";
import { createFakeDesktopCaptureExtras } from "../fakeDesktopCaptureExtras";
import type { DesktopBridge } from "./desktopVoiceNotes";
import { createTauriDesktopCaptureExtras } from "./tauriDesktopCaptureExtras";

// The call prompt's setting on the desktop extras: `call_prompt_get` and `call_prompt_set`, dropped for the session
// by a build that does not have them.

function bridge(replies: Record<string, (args: Record<string, unknown>) => unknown>) {
  const log: string[] = [];
  const value: DesktopBridge = {
    listen: async () => () => {},
    invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
      log.push(Object.keys(args).length ? `${command}:${JSON.stringify(args)}` : command);
      const reply = replies[command];
      if (!reply) throw new Error(`Unexpected command ${command}`);
      return reply(args) as T;
    },
  };
  return { log, bridge: value };
}

describe("Tauri DesktopCaptureExtras, call prompt", () => {
  test("binds get and set to their commands", async () => {
    const { log, bridge: value } = bridge({ call_prompt_get: () => ({ enabled: true, supported: true }), call_prompt_set: () => null });
    const callPrompt = createTauriDesktopCaptureExtras(value).callPrompt!;
    expect(await callPrompt.get()).toEqual({ enabled: true, supported: true });
    await callPrompt.set(false);
    expect(log).toEqual(["call_prompt_get", 'call_prompt_set:{"enabled":false}']);
  });

  test("a native side without the commands refuses once; from then on the member is absent", async () => {
    for (const refusal of ["Command call_prompt_get not found", "call_prompt_get not allowed. Command not found",
      "Command call_prompt_get not allowed by ACL"]) {
      const { bridge: value } = bridge({ call_prompt_get: () => { throw refusal; }, call_names_get: () => ({ enabled: false, permission: "missing" }) });
      const extras = createTauriDesktopCaptureExtras(value);
      const info = spyOn(console, "info").mockImplementation(() => {});
      try {
        await expect(extras.callPrompt!.get()).rejects.toBe(refusal);
        expect(info).toHaveBeenCalledTimes(1);
      } finally { info.mockRestore(); }
      expect(extras.callPrompt).toBeUndefined();
      // Names in the call are not affected.
      expect(await extras.callNames!.get()).toEqual({ enabled: false, permission: "missing" });
    }
  });

  test("a failure the command itself reports keeps the member", async () => {
    const { bridge: value } = bridge({ call_prompt_set: () => { throw "watcher stopped"; } });
    const extras = createTauriDesktopCaptureExtras(value);
    await expect(extras.callPrompt!.set(true)).rejects.toBe("watcher stopped");
    expect(extras.callPrompt).toBeDefined();
  });
});

describe("readCallPromptState", () => {
  test("only { enabled: boolean, supported: boolean }", () => {
    expect(readCallPromptState({ enabled: true, supported: true })).toEqual({ enabled: true, supported: true });
    expect(readCallPromptState({ enabled: false, supported: false, extra: 1 })).toEqual({ enabled: false, supported: false });
    for (const answer of [null, undefined, true, "on", {}, { enabled: true }, { supported: true }, { enabled: 1, supported: true }])
      expect(readCallPromptState(answer)).toBeNull();
  });
});

describe("the fake's call prompt", () => {
  test("absent unless asked for; on and supported by default; records its calls and fails on request", async () => {
    expect(createFakeDesktopCaptureExtras().extras.callPrompt).toBeUndefined();
    const fake = createFakeDesktopCaptureExtras({ callPrompt: {} });
    expect(await fake.extras.callPrompt!.get()).toEqual({ enabled: true, supported: true });
    await fake.extras.callPrompt!.set(false);
    expect(await fake.extras.callPrompt!.get()).toEqual({ enabled: false, supported: true });
    fake.failNext("callPrompt.set", "nope");
    await expect(fake.extras.callPrompt!.set(true)).rejects.toThrow("nope");
    expect(fake.calls).toEqual(["callPrompt.get", "callPrompt.set:false", "callPrompt.get", "callPrompt.set:true"]);
    expect(await createFakeDesktopCaptureExtras({ callPrompt: { supported: false } }).extras.callPrompt!.get())
      .toEqual({ enabled: true, supported: false });
  });
});
