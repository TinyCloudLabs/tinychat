import { expect, test } from "bun:test";
import {
  recorderLayout,
  recorderSizing,
  shellCapabilities,
  shellForPlatform,
} from "./shellCapabilities";

test("shell capabilities are derived from the app platform", () => {
  expect(shellForPlatform("ios")).toBe("phone");
  expect(shellCapabilities("android", "phone")).toMatchObject({
    localTranscription: true,
    backgroundRecording: true,
    meetingSources: false,
    notYetUploadedList: true,
  });
  expect(shellCapabilities("tauri", "desktop")).toMatchObject({
    systemAudio: true,
    meetingSources: true,
    captureSettings: true,
    globalShortcuts: true,
  });
  expect(shellCapabilities("web", "desktop")).toMatchObject({
    localTranscription: false,
    backgroundRecording: false,
    notYetUploadedList: false,
  });
});
test("capabilities are shell × layout", () => {
  for (const layout of ["rail", "desktop"] as const)
    expect(shellCapabilities("web", layout)).toMatchObject({
      captureSettings: "microphone-only",
      meetingSources: true,
      systemAudio: false,
      globalShortcuts: false,
    });
  expect(shellCapabilities("web", "phone")).toMatchObject({
    captureSettings: false,
    meetingSources: false,
  });
  for (const layout of ["phone", "rail", "desktop"] as const) {
    expect(shellCapabilities("tauri", layout)).toMatchObject({
      captureSettings: true,
      meetingSources: true,
      systemAudio: true,
      globalShortcuts: true,
    });
    for (const platform of ["ios", "android"] as const)
      expect(shellCapabilities(platform, layout)).toMatchObject({
        captureSettings: false,
        meetingSources: false,
        systemAudio: false,
      });
  }
});
test("layout and dimensions follow the breakpoint and short-height rules", () => {
  expect([
    recorderLayout(767),
    recorderLayout(768),
    recorderLayout(1023),
    recorderLayout(1024),
  ]).toEqual(["phone", "rail", "rail", "desktop"]);
  expect(recorderSizing(768, 699)).toEqual({ ringPx: 172, timerPx: 60 });
  expect(recorderSizing(768, 700)).toEqual({ ringPx: 214, timerPx: 76 });
  expect(recorderSizing(500, 900)).toEqual({ ringPx: 172, timerPx: 60 });
});
