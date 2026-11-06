import { afterAll, beforeAll, expect, test } from "bun:test";
import { captureEngineKind } from "../captureEngine";
import { registerWebCaptureEngine } from "./registerWebEngine";

// A browser that could record: the only thing missing on the Home site is the registered engine.
// Registering is process-wide and cannot be undone, so only the Home case runs here (it registers nothing);
// the globals are put back for the files that run after this one.
const saved = {
  mediaRecorder: Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};
beforeAll(() => {
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, writable: true, value: class {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {} } });
});
afterAll(() => {
  for (const [name, descriptor] of [["MediaRecorder", saved.mediaRecorder], ["navigator", saved.navigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("the Home site registers no web capture engine, so nothing in it can record", () => {
  registerWebCaptureEngine(true);
  expect(captureEngineKind()).toBeNull();
});
