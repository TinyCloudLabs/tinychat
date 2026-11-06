import { expect, test } from "bun:test";
import { captureEngineKind } from "../captureEngine";
import { registerWebCaptureEngine } from "./registerWebEngine";

// A browser that could record: the only thing missing on the Home site is the registered engine.
Object.assign(globalThis, { MediaRecorder: class {} });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {} } });

test("the Home site registers no web capture engine, so nothing in it can record", () => {
  registerWebCaptureEngine(true);
  expect(captureEngineKind()).toBeNull();
});

test("other web builds register it", () => {
  registerWebCaptureEngine(false);
  expect(captureEngineKind()).toBe("web");
});
