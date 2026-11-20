// Pins the phone apps' WebView origins (TC-3045). The SDK and the backend trust these exact strings, so a config
// change that moves either app to another origin must fail here, not in a tester's hands.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { EXO_ANDROID_ORIGIN, EXO_IOS_ORIGIN } from "../backend/src/cors-origins";
import { ANDROID_WEBVIEW_ORIGIN, IOS_WEBVIEW_ORIGIN } from "../frontend/src/lib/nativeOrigins";

const ANDROID = "https://app.tinycloud.one";
const IOS = "tinycloudone://app.tinycloud.one";

type Server = { url?: string; hostname?: string; androidScheme?: string; iosScheme?: string } | undefined;

// How Capacitor 8 builds the origin it serves the bundle from when no `server.url` is set (CapConfig.java,
// CAPInstanceDescriptor.swift): Android takes `androidScheme` only if it is http or https (default "https"), iOS
// lowercases `iosScheme` (default "capacitor"), and both use `server.hostname` (default "localhost").
const androidOrigin = (server: Server) => {
  const scheme = server?.androidScheme === "http" || server?.androidScheme === "https" ? server.androidScheme : "https";
  return `${scheme}://${server?.hostname ?? "localhost"}`;
};
const iosOrigin = (server: Server) => `${server?.iosScheme?.toLowerCase() ?? "capacitor"}://${server?.hostname ?? "localhost"}`;

async function releaseConfig(): Promise<{ server?: Server }> {
  const saved = process.env.EXO_DEV_SERVER_URL;
  delete process.env.EXO_DEV_SERVER_URL;
  try {
    return (await import("./capacitor.config.ts")).default;
  } finally {
    if (saved !== undefined) process.env.EXO_DEV_SERVER_URL = saved;
  }
}

describe("phone app WebView origins", () => {
  test("a release build serves the bundle from the app's own origin on each platform", async () => {
    const { server } = await releaseConfig();
    expect(server?.url).toBeUndefined();
    expect(androidOrigin(server)).toBe(ANDROID);
    expect(iosOrigin(server)).toBe(IOS);
  });

  test("the backend and the frontend name the same origins", () => {
    expect([EXO_ANDROID_ORIGIN, EXO_IOS_ORIGIN]).toEqual([ANDROID, IOS]);
    expect([ANDROID_WEBVIEW_ORIGIN, IOS_WEBVIEW_ORIGIN]).toEqual([ANDROID, IOS]);
  });

  // `cap sync` writes these into the native projects; CI syncs before running this file, so the configs the apps
  // actually read are checked too.
  const synced = [
    ["android/app/src/main/assets/capacitor.config.json", androidOrigin, ANDROID],
    ["ios/App/App/capacitor.config.json", iosOrigin, IOS],
  ] as const;
  for (const [path, origin, expected] of synced) {
    const file = new URL(`./${path}`, import.meta.url);
    test.skipIf(!existsSync(file))(`the synced ${path} serves ${expected}`, () => {
      const { server } = JSON.parse(readFileSync(file, "utf8")) as { server?: Server };
      expect(server?.url).toBeUndefined();
      expect(origin(server)).toBe(expected);
    });
  }
});
