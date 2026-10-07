// TC-775 E1 — secrets gating on native OpenKey sessions.
//
// `secretsAvailable()` is the one predicate: false only inside the Exo app
// (ios/android) when the build sets VITE_EXO_NATIVE_OPENKEY=true. These tests
// pin both sides of it — unlockSecrets refuses BEFORE touching tcw.secrets and
// isSecretsUnlocked reports locked — and that web/desktop sessions are
// untouched (the default test environment is web). The test seam
// setSecretsAvailableForTests pins the gate without mocking Capacitor.

import { afterEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  SECRETS_UNAVAILABLE_IN_APP_MESSAGE,
  setSecretsAvailableForTests,
  useNativeOpenKey,
} from "./openkeyNative";
import { isSecretsUnlocked, unlockSecrets } from "./connectors/connectorSecrets";

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
      unlock: async () => {
        calls.push("unlock");
        return { ok: true, data: undefined };
      },
    },
  } as unknown as Pick<TinyCloudWeb, "secrets">;
  return { tcw, calls };
}

describe("secretsAvailable gate", () => {
  test("is false only inside the flagged native app", () => {
    expect(useNativeOpenKey("ios", { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
    expect(useNativeOpenKey("android", { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
    // Web and the Tauri desktop always have secrets.
    expect(useNativeOpenKey("web", { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(false);
    expect(useNativeOpenKey("tauri", { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(false);
    expect(useNativeOpenKey("ios", {})).toBe(false);
  });

  test("unlockSecrets refuses on native before touching the vault", async () => {
    setSecretsAvailableForTests(false);
    const { tcw, calls } = fakeTcw();
    const result = await unlockSecrets(tcw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error?.message).toBe(SECRETS_UNAVAILABLE_IN_APP_MESSAGE);
    }
    expect(calls).toEqual([]);
  });

  test("isSecretsUnlocked reports locked on native without reading the vault", () => {
    setSecretsAvailableForTests(false);
    const { tcw, calls } = fakeTcw(true);
    expect(isSecretsUnlocked(tcw)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("web behaviour is unchanged by the gate", async () => {
    const { tcw, calls } = fakeTcw();
    const result = await unlockSecrets(tcw);
    expect(result).toEqual({ ok: true, data: undefined });
    expect(calls).toEqual(["unlock"]);
    expect(isSecretsUnlocked(fakeTcw(true).tcw)).toBe(true);
  });
});
