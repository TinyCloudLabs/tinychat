import { expect, test } from "bun:test";
import { createErrorBuffer, ERROR_MSG_CHARS, osMajor } from "./context";
import { redactForReport } from "./redact";

test("recent errors: the newest ten, newest first, name and message only, never a stack", () => {
  const buffer = createErrorBuffer();
  for (let i = 0; i < 25; i++) buffer.record(new TypeError(`boom ${i}`), 1_000 * i);
  const lines = buffer.recent(30_000, redactForReport);
  expect(lines).toHaveLength(10);
  expect(lines[0]).toEqual({ age_s: 6, msg: "TypeError: boom 24" });
  expect(lines[9].msg).toBe("TypeError: boom 15");
  expect(lines.some((line) => line.msg.includes("at "))).toBe(false);
});

test("an error message is redacted before it is cut, so a secret straddling the cut doesn't leak in part", () => {
  const buffer = createErrorBuffer();
  const did = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
  buffer.record(new Error(`${"x".repeat(ERROR_MSG_CHARS - 30)} ${did}`), 0);
  const [line] = buffer.recent(0, redactForReport);
  expect(line.msg.length).toBeLessThanOrEqual(ERROR_MSG_CHARS);
  expect(line.msg).not.toContain("did:pkh");
  expect(line.msg).not.toContain("0xd559");
});

test("cleared on sign-out", () => {
  const buffer = createErrorBuffer();
  buffer.record(new Error("x"), 0);
  buffer.clear();
  expect(buffer.recent(0, redactForReport)).toEqual([]);
});

test("OS major version from the phone WebView's user agent; none elsewhere", () => {
  expect(osMajor("ios", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)")).toBe("18");
  expect(osMajor("android", "Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("14");
  expect(osMajor("web", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBeUndefined();
});
