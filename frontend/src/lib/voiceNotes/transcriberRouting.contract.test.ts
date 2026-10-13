// The JS routing tests exercise saved-note choices. Pin the two native queue gates too: an Off
// or private-cloud sidecar must never enter native STT, even after a later reconciliation, unless
// the user chose Local for it (which enqueue records as `stt.requested`).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

test("iOS and Android only reconcile on-device or Local-requested notes into native STT", () => {
  const ios = source("mobile/ios/Packages/ExoStt/Sources/ExoStt/TranscriptionCore.swift");
  const android = source("mobile/android/app/src/main/java/xyz/tinycloud/exo/stt/core/ResumableWork.kt");
  const queue = source("mobile/android/app/src/main/java/xyz/tinycloud/exo/stt/TranscriptionQueue.kt");
  expect(ios).toContain('committed == "on-device" || stt["requested"] as? Bool == true');
  expect(ios).toContain("ResumableWork.owed(note)");
  expect(android).toContain('optString("transcriber") == "on-device" || stt.optBoolean("requested")');
  expect(queue).toContain("if (!ResumableWork.owed(note)) continue");
});
