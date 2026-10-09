import { expect, test } from "bun:test";
import { recorderLayout, recorderSizing, shellCapabilities, shellForPlatform } from "./shellCapabilities";

test("shell capabilities are derived from the app platform", () => {
  expect(shellForPlatform("ios")).toBe("phone");
  expect(shellCapabilities("android")).toMatchObject({ localTranscription: true, backgroundRecording: true, meetingSources: false, notYetUploadedList: true });
  expect(shellCapabilities("tauri")).toMatchObject({ systemAudio: true, meetingSources: true, captureSettings: true, globalShortcuts: true });
  expect(shellCapabilities("web")).toMatchObject({ localTranscription: false, backgroundRecording: false, notYetUploadedList: false });
});
test("layout and dimensions follow the breakpoint and short-height rules", () => {
  expect([recorderLayout(767), recorderLayout(768), recorderLayout(1023), recorderLayout(1024)]).toEqual(["phone", "rail", "rail", "desktop"]);
  expect(recorderSizing(768, 699)).toEqual({ ringPx: 172, timerPx: 60 });
  expect(recorderSizing(768, 700)).toEqual({ ringPx: 214, timerPx: 76 });
  expect(recorderSizing(500, 900)).toEqual({ ringPx: 172, timerPx: 60 });
});
