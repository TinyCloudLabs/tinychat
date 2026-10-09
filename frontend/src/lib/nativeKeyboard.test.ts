import { describe, expect, test } from "bun:test";
import {
  createNativeKeyboard,
  type KeyboardPluginLike,
} from "./nativeKeyboard";

function fakePlugin(options: { failHide?: boolean; failRestore?: boolean } = {}) {
  const calls: string[] = [];
  const plugin: KeyboardPluginLike = {
    async setAccessoryBarVisible({ isVisible }) {
      if (!isVisible && options.failHide) throw new Error("hide failed");
      if (isVisible && options.failRestore) throw new Error("restore failed");
      calls.push(isVisible ? "bar:visible" : "bar:hidden");
    },
  };
  return { plugin, calls };
}

function setup(platform: string, options?: Parameters<typeof fakePlugin>[0]) {
  const fake = fakePlugin(options);
  let loads = 0;
  const keyboard = createNativeKeyboard({
    platform: () => platform,
    load: async () => {
      loads += 1;
      return fake.plugin;
    },
  });
  return { ...fake, keyboard, loads: () => loads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function withErrors<T>(run: () => Promise<T>) {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    return { result: await run(), errors };
  } finally {
    console.error = original;
  }
}

describe("nativeKeyboard", () => {
  for (const platform of ["web", "android", "tauri"]) {
    test(`never loads the plugin on ${platform}`, async () => {
      const t = setup(platform);
      await t.keyboard.restoreAccessoryBar();
      t.keyboard.holdAccessoryBarHidden()();
      await settle();
      expect(t.loads()).toBe(0);
      expect(t.calls).toEqual([]);
    });
  }

  test("restores the accessory bar at boot on iOS", async () => {
    const t = setup("ios");
    await t.keyboard.restoreAccessoryBar();
    expect(t.calls).toEqual(["bar:visible"]);
  });

  test("hides the accessory bar only while held and restores it on release", async () => {
    const t = setup("ios");
    expect(t.loads()).toBe(0);
    const release = t.keyboard.holdAccessoryBarHidden();
    await settle();
    expect(t.calls).toEqual(["bar:hidden"]);
    release();
    release();
    await settle();
    expect(t.calls).toEqual(["bar:hidden", "bar:visible"]);
  });

  test("holds add up: the bar is back only when none is left", async () => {
    const t = setup("ios");
    const first = t.keyboard.holdAccessoryBarHidden();
    const second = t.keyboard.holdAccessoryBarHidden();
    await settle();
    first();
    await settle();
    expect(t.calls).toEqual(["bar:hidden"]);
    second();
    await settle();
    expect(t.calls).toEqual(["bar:hidden", "bar:visible"]);
  });

  test("a hold released before the bar was hidden never hides it", async () => {
    const t = setup("ios");
    t.keyboard.holdAccessoryBarHidden()();
    await settle();
    expect(t.calls).toEqual([]);
  });

  test("closing and reopening in a row ends hidden, in order", async () => {
    const t = setup("ios");
    const first = t.keyboard.holdAccessoryBarHidden();
    await settle();
    first();
    t.keyboard.holdAccessoryBarHidden();
    await settle();
    expect(t.calls).toEqual(["bar:hidden"]);
  });

  test("a failure to hide is logged and leaves the bar visible", async () => {
    const t = setup("ios", { failHide: true });
    const { errors } = await withErrors(async () => {
      t.keyboard.holdAccessoryBarHidden();
      await settle();
    });
    expect(t.calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toContain("Could not hide");
  });

  test("a failure to restore is logged", async () => {
    const t = setup("ios", { failRestore: true });
    const held = t.keyboard.holdAccessoryBarHidden();
    await settle();
    const { errors } = await withErrors(async () => {
      held();
      await settle();
    });
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toContain("Could not restore");
  });
});
