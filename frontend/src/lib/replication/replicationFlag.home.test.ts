import { expect, test } from "bun:test";
import { isReplicationAvailable, isReplicationEnabled, type ReplicationEnv } from "./replicationFlag";

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
const ON = { killSwitchOpen: true, buildFlag: "true", runtimeFlag: false, userOptIn: true, env: CHROME_DESKTOP } as const;

// The replica mirrors meeting transcripts, which the Home site's sign-in no longer covers.
test("the Home site never builds or fills a replica, whatever the flags say", () => {
  expect(isReplicationAvailable({ ...ON, homeSite: true })).toBe(false);
  expect(isReplicationEnabled({ ...ON, homeSite: true })).toBe(false);
});

test("other builds are unchanged", () => {
  expect(isReplicationAvailable({ ...ON, homeSite: false })).toBe(true);
  expect(isReplicationEnabled({ ...ON, homeSite: false })).toBe(true);
});
