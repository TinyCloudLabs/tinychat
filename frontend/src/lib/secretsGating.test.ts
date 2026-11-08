// TC-775 E1 — secrets gating on native OpenKey sessions.
//
// `secretsAvailable()` is the one predicate: false only for an active native
// delegation session. These tests
// pin both sides of it — isSecretsUnlocked reports locked on native without
// reading the vault — and that web/desktop sessions are
// untouched (the default test environment is web). The test seam
// setSecretsAvailableForTests pins the gate without mocking Capacitor.

import { afterEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { setSecretsAvailableForTests, isNativeOpenKeySignIn } from "./openkeyNative";
import { isSecretsUnlocked } from "./connectors/connectorSecrets";

afterEach(() => {
  setSecretsAvailableForTests(null);
});

function fakeTcw(unlocked = false) {
  const calls: string[] = [];
  const tcw = {
    secrets: {
      get isUnlocked() {
        calls.push("isUnlocked");
        return unlocked;
      },
    },
  } as unknown as Pick<TinyCloudWeb, "secrets">;
  return { tcw, calls };
}

describe("secretsAvailable gate", () => {
  test("native sign-in is limited to iOS and Android", () => {
    expect(isNativeOpenKeySignIn("ios")).toBe(true);
    expect(isNativeOpenKeySignIn("android")).toBe(true);
    // Web and the Tauri desktop always have secrets.
    expect(isNativeOpenKeySignIn("web")).toBe(false);
    expect(isNativeOpenKeySignIn("tauri")).toBe(false);
  });

  test("isSecretsUnlocked reports locked on native without reading the vault", () => {
    setSecretsAvailableForTests(false);
    const { tcw, calls } = fakeTcw(true);
    expect(isSecretsUnlocked(tcw)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("web behaviour is unchanged by the gate", () => {
    const { tcw, calls } = fakeTcw(true);
    expect(isSecretsUnlocked(tcw)).toBe(true);
    expect(calls).toEqual(["isUnlocked"]);
  });
});
