import { expect, test } from "bun:test";

import { MAX_CHOICE, MAX_QUESTION, isDeclinedReply, plainText } from "./askText";

test("control, bidirectional and zero-width characters never reach the card", () => {
  const hostile = "pay\u202Eknab\u202C\u2066x\u2069 now\u0000\u0007\u001b[31m\u200b\u200e\u061c\ufeff\u2028done\u0085";
  const shown = plainText(hostile, MAX_QUESTION);
  expect(shown).toBe("pay knab x now [31m done");
  expect(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(shown)).toBe(false);
});

test("a line break in a question becomes a space, so a quote stays one paragraph", () => {
  expect(plainText("one\ntwo\r\n\r\nthree\tfour", MAX_QUESTION)).toBe("one two three four");
});

test("links, markup and Markdown stay as the characters they are", () => {
  const text = "See [x](https://evil.test/a) <img src=\"https://evil.test/p.png\"> https://evil.test/bare ![i](https://evil.test/i.png)";
  expect(plainText(text, MAX_QUESTION)).toBe(text);
});

test("text is cut at the limit by characters, not by code units, and says so", () => {
  const long = "🙂".repeat(MAX_CHOICE + 10);
  const cut = plainText(long, MAX_CHOICE);
  expect([...cut]).toHaveLength(MAX_CHOICE);
  expect(cut.endsWith("…")).toBe(true);
  expect(plainText("short", MAX_CHOICE)).toBe("short");
});

test("only the service's not-now message is recognized as a decline", () => {
  expect(isDeclinedReply("The person chose not to answer now. Carry on without it.")).toBe(true);
  expect(isDeclinedReply("The person answered your question: no")).toBe(false);
});
