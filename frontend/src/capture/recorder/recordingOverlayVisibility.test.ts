import { expect, test } from "bun:test";
import { shouldMountRecordingOverlay } from "./recordingOverlayVisibility";

test("a live recorder stays visible when native sign-in replaces the device shell", () => {
  const base = { voiceNotesInApp: true, isReady: false, deviceCapture: true,
    nativeSignInScreenShown: false, shareTokenPresent: false };
  expect(shouldMountRecordingOverlay(base)).toBe(false); // the device shell owns its overlay
  expect(shouldMountRecordingOverlay({ ...base, nativeSignInScreenShown: true })).toBe(true);
  expect(shouldMountRecordingOverlay({ ...base, shareTokenPresent: true })).toBe(true);
  expect(shouldMountRecordingOverlay({ ...base, deviceCapture: false })).toBe(true);
  expect(shouldMountRecordingOverlay({ ...base, isReady: true, nativeSignInScreenShown: true })).toBe(false);
});
