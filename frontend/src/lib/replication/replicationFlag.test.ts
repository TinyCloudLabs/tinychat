import { describe, expect, test } from "bun:test";
import { isReplicationAvailable, isReplicationEnabled, replicationPlatformRefusal, type ReplicationEnv } from "./replicationFlag";

const CHROME_DESKTOP: ReplicationEnv = {
  platform: "web",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  brands: ["Chromium", "Google Chrome"],
  maxTouchPoints: 0,
  hasIndexedDb: true,
  hasWorker: true,
  hasLocks: true,
  hasSubtleCrypto: true,
};
const ON = { killSwitchOpen: true, buildFlag: "true", runtimeFlag: false, userOptIn: true } as const;

describe("replication flag", () => {
  test("is OFF by default, even in a qualified browser", () => {
    expect(isReplicationEnabled({ killSwitchOpen: true, buildFlag: undefined, runtimeFlag: false, userOptIn: true, env: CHROME_DESKTOP })).toBe(false);
    expect(isReplicationEnabled({ killSwitchOpen: true, buildFlag: "false", runtimeFlag: false, userOptIn: true, env: CHROME_DESKTOP })).toBe(false);
  });

  test("turns on from the build flag or the runtime flag in Chromium on the web, once the user opted in", () => {
    expect(isReplicationEnabled({ ...ON, env: CHROME_DESKTOP })).toBe(true);
    expect(isReplicationEnabled({ killSwitchOpen: true, runtimeFlag: true, buildFlag: undefined, userOptIn: true, env: CHROME_DESKTOP })).toBe(true);
  });

  test("the hard-coded kill switch beats every flag", () => {
    expect(isReplicationEnabled({ ...ON, killSwitchOpen: false, runtimeFlag: true, env: CHROME_DESKTOP })).toBe(false);
  });

  test("truth table: ON only when kill switch open AND build flag AND qualified platform AND the user opted in", () => {
    const tauri: ReplicationEnv = { ...CHROME_DESKTOP, platform: "tauri" };
    for (const killSwitchOpen of [true, false]) {
      for (const buildFlag of ["true", undefined]) {
        for (const env of [CHROME_DESKTOP, tauri]) {
          for (const userOptIn of [true, false]) {
            const inputs = { killSwitchOpen, buildFlag, runtimeFlag: false, env, userOptIn };
            const gates = killSwitchOpen && buildFlag === "true" && env === CHROME_DESKTOP;
            expect(isReplicationEnabled(inputs)).toBe(gates && userOptIn);
            // The switch is offered on the gates alone; the user's choice never makes it available.
            expect(isReplicationAvailable(inputs)).toBe(gates);
          }
        }
      }
    }
  });

  test("a qualified build and browser with no stored choice and no principal is OFF", () => {
    expect(isReplicationEnabled({ killSwitchOpen: true, buildFlag: "true", runtimeFlag: false, env: CHROME_DESKTOP })).toBe(false);
    expect(isReplicationEnabled({ killSwitchOpen: true, buildFlag: "true", runtimeFlag: false, env: CHROME_DESKTOP, principal: "did:pkh:eip155:1:0xaaaa" })).toBe(false);
  });

  test("refuses Tauri, Capacitor (iOS/Android shells)", () => {
    for (const platform of ["tauri", "ios", "android"] as const) {
      expect(isReplicationEnabled({ ...ON, env: { ...CHROME_DESKTOP, platform } })).toBe(false);
    }
  });

  test("refuses every iOS browser, including Chromium-branded WebKit and iPadOS desktop mode", () => {
    const iosChrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1";
    const iPadDesktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, userAgent: iosChrome })).toBe("ios-webkit");
    // Even if a UA string claimed Chrome, iPhone in the UA is refused.
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, userAgent: `${iosChrome} Chrome/130` })).toBe("ios-webkit");
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, userAgent: iPadDesktop, brands: [], maxTouchPoints: 5 })).toBe("ios-webkit");
  });

  test("refuses Safari and Firefox, and a browser missing a required API", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, userAgent: safari, brands: [] })).toBe("not-chromium");
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, userAgent: firefox, brands: [] })).toBe("not-chromium");
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, hasLocks: false })).toBe("missing-browser-api");
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, hasIndexedDb: false })).toBe("missing-browser-api");
  });

  test("accepts Chrome on Android web", () => {
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
    expect(replicationPlatformRefusal({ ...CHROME_DESKTOP, userAgent: android, maxTouchPoints: 5 })).toBeNull();
  });
});
