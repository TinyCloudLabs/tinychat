// The JS routing tests exercise saved-note choices. Pin the two native queue gates too: an Off
// or private-cloud sidecar must never enter native STT, even after a later reconciliation.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

test("iOS and Android only reconcile on-device notes into native STT", () => {
  const ios = source("mobile/ios/Packages/ExoStt/Sources/ExoStt/TranscriptionQueue.swift");
  const android = source("mobile/android/app/src/main/java/xyz/tinycloud/exo/stt/TranscriptionQueue.kt");
  expect(ios).toContain('options["transcriber"] as? String == "on-device"');
  expect(android).toContain('if (options.optString("transcriber") != "on-device") continue');
});
